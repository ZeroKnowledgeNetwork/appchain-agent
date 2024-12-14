import { PrivateKey, PublicKey } from "o1js";
import { CommandResponse, FAILURE, PENDING } from "./types";
import { getTxnStatus } from "chain";

export class TxHandler {
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

      const { status, statusMessage } = await getTxnStatus(
        tx.transaction,
        () => {
          console.log("⏳ waiting for tx to be confirmed...");
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
}
