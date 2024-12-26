import { PrivateKey, PublicKey } from "o1js";
import { CommandResponse, FAILURE, PENDING } from "./types";
import { qry } from "chain";

interface TxTask {
  txfn: () => Promise<void>;
  resolve: (value: CommandResponse) => void;
  reject: (reason?: any) => void;
}

/**
 * TxHandler manages transaction submission and confirmation status checking.
 *
 * A queue is used to manage multiple transactions, ensuring that
 * 1) they are submitted to the sequencer and/or processed in order (as nonce matters!)
 * 2) the transaction has been confirmed before proceeding to the next one.
 *
 * Behavior can be customized with the following options:
 * - nonce: internally track nonce for the public key
 *   (if false, nonce is fetched from the chain for each transaction)
 *   (if true, nonce is manually incremented for each transaction, after an initial fetch)
 * - txStatusInterval: time to wait before and between tx status checking
 * - txStatusRetries: number of times to check tx status before giving up
 */
export class TxHandler {
  private txQueue: TxTask[] = [];
  private isProcessing = false;
  private nonce: number | undefined;

  constructor(
    private client: any,
    private publicKey: PublicKey,
    private privateKey: PrivateKey,
    private opts: {
      nonce: boolean;
      txStatusInterval: string;
      txStatusRetries: string;
    },
  ) {}

  // helper function to send transactions
  public async submitTx(txfn: () => Promise<void>): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      this.txQueue.push({ txfn, resolve, reject });
      this.processQueue().catch((err) => {
        console.error("Error processing transaction queue:", err);
        while (this.txQueue.length > 0) {
          const task = this.txQueue.shift();
          task?.reject(err);
        }
      });
    });
  }

  private async processTx(txfn: () => Promise<void>): Promise<CommandResponse> {
    const nonce = this.nonce;
    const tx = await this.client.transaction(this.publicKey, txfn, { nonce });
    console.log("tx.nonce", tx.transaction!.nonce.toString());
    tx.transaction = tx.transaction?.sign(this.privateKey);
    await tx.send();

    if (tx.transaction) {
      // client.transaction will fetch nonce from the chain if not given as an option.
      // An internally tracked nonce only works for one agent instance per public key
      // but enables submission of many txns without waiting for their confirmation.
      if (this.opts.nonce) this.nonce = Number(tx.transaction.nonce) + 1;

      const { status, statusMessage } = await qry.indexer.getTxStatus(
        tx.transaction.hash().toString(),
        () => {
          console.log("⏳ Waiting for tx status...");
        },
        parseInt(this.opts.txStatusInterval),
        parseInt(this.opts.txStatusRetries),
      );
      return {
        status,
        data: status !== FAILURE ? statusMessage : undefined,
        error: status === FAILURE ? statusMessage : undefined,
        tx: tx.transaction.hash().toString(),
      };
    }

    return { status: PENDING };
  }

  private async processQueue() {
    if (this.isProcessing || this.txQueue.length === 0) return;

    this.isProcessing = true;
    while (this.txQueue.length > 0) {
      const { txfn, resolve, reject } = this.txQueue[0];
      try {
        const result = await this.processTx(txfn);
        resolve(result);
      } catch (err) {
        reject(err);
      }

      this.txQueue.shift();
    }
    this.isProcessing = false;
  }
}
