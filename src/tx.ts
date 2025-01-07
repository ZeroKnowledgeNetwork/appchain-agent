import { PrivateKey, PublicKey } from "o1js";
import { CommandRequest, CommandResponse, FAILURE, PENDING } from "./types";
import { qry } from "@zkn/qry";

interface TxTask {
  txfn: () => Promise<void>;
  cmdReq: CommandRequest;
  timeSubmit: number;
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
  public async submitTx(
    txfn: () => Promise<void>,
    cmdReq: CommandRequest,
  ): Promise<CommandResponse> {
    const id = cmdReq.id ?? "?";
    return new Promise((resolve, reject) => {
      const timeSubmit = Date.now();
      this.txQueue.push({ txfn, cmdReq, timeSubmit, resolve, reject });
      console.log(
        `--- [${id}] Submission`,
        `queue=${this.txQueue.length}`,
        `$ ${cmdReq.command}`,
      );
      this.processQueue().catch((err) => {
        console.error(`--- [${id}] ❌ Error processing tx queue:`, err);
        while (this.txQueue.length > 0) {
          const task = this.txQueue.shift();
          task?.reject(err);
        }
      });
    });
  }

  private async processTx(
    txfn: () => Promise<void>,
    cmdReq: CommandRequest,
    timeSubmit: number,
  ): Promise<CommandResponse> {
    const timeProcess = Date.now();
    const id = cmdReq.id ?? "?";
    const nonce = this.nonce;
    const tx = await this.client.transaction(this.publicKey, txfn, { nonce });
    tx.transaction = tx.transaction?.sign(this.privateKey);
    await tx.send();

    if (tx.transaction) {
      // client.transaction will fetch nonce from the chain if not given as an option.
      // An internally tracked nonce only works for one agent instance per public key
      // but enables submission of many txns without waiting for their confirmation.
      if (this.opts.nonce) this.nonce = Number(tx.transaction.nonce) + 1;

      const h7 = (tx.transaction.hash().toString() as string).substring(0, 7);

      const { status, statusMessage } = await qry.processor.getTxStatus(
        tx.transaction.hash().toString(),
        () => {
          console.log(
            `--- [${id}] ⏳ Awaiting status for`,
            `tx=${h7}...`,
            `n=${tx.transaction.nonce}`,
            `q=${this.txQueue.length}`,
            `$ ${cmdReq.command}`,
          );
        },
        parseInt(this.opts.txStatusInterval),
        parseInt(this.opts.txStatusRetries),
      );

      console.log(
        `--- [${id}] ${status === FAILURE ? "❌" : "✅"} Returning status for`,
        `tx=${h7}...`,
        `n=${tx.transaction.nonce}`,
        `q=${this.txQueue.length}`,
        `t=${timeProcess - timeSubmit}` +
          "/" +
          `${Date.now() - timeProcess}` +
          "/" +
          `${Date.now() - timeSubmit}` +
          "ms",
        `$ ${cmdReq.command}`,
      );

      return {
        status,
        data: status !== FAILURE ? statusMessage : undefined,
        error: status === FAILURE ? statusMessage : undefined,
        tx: tx.transaction.hash().toString(),
      };
    }

    console.error(`--- [${id}] ❌ !tx.transaction`);
    return { status: PENDING };
  }

  private async processQueue() {
    if (this.isProcessing || this.txQueue.length === 0) return;

    this.isProcessing = true;
    while (this.txQueue.length > 0) {
      const { txfn, cmdReq, timeSubmit, resolve, reject } = this.txQueue[0];
      try {
        const result = await this.processTx(txfn, cmdReq, timeSubmit);
        resolve(result);
      } catch (err) {
        reject(err);
      }

      this.txQueue.shift();
    }
    this.isProcessing = false;
  }
}
