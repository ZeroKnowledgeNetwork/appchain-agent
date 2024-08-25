import path from "path";
import { unixfs } from "@helia/unixfs";
import { FsBlockstore } from "blockstore-fs";
import { FsDatastore } from "datastore-fs";
import { createHelia } from "helia";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { bootstrap } from "@libp2p/bootstrap";
import { identify } from "@libp2p/identify";
import { stop } from "@libp2p/interface";
import { CID } from "multiformats/cid";

import type { HeliaLibp2p } from "helia";
import type { Libp2p, ServiceMap } from "@libp2p/interface";
import type { UnixFS } from "@helia/unixfs";

type HeliaType = HeliaLibp2p<Libp2p<ServiceMap>>;

export type IPFSNodeOptions = {
  dataPath: string;
};

export class IPFSNode {
  blockstore: FsBlockstore;
  datastore: FsDatastore;
  helia: HeliaType | undefined;
  fs: UnixFS | undefined;

  constructor(opts: IPFSNodeOptions) {
    this.blockstore = new FsBlockstore(path.join(opts.dataPath, "block"));
    this.datastore = new FsDatastore(path.join(opts.dataPath, "data"));
  }

  /**
   * Start the IPFS node
   */
  public async start() {
    // create a Helia node
    this.helia = await createHelia({
      datastore: this.datastore,
      blockstore: this.blockstore,
      libp2p: {
        addresses: {
          listen: [
            // add a listen address (localhost) to accept TCP connections on a random port
            "/ip4/127.0.0.1/tcp/0",
          ],
        },
        transports: [tcp()],
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        peerDiscovery: [
          bootstrap({
            list: [
              "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
              "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
              "/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp",
              "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
              "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
            ],
          }),
        ],
        services: {
          identify: identify(),
        },
      },
    });

    console.log(
      `IPFSNode started with id ${this.helia.libp2p.peerId.toString()}`,
    );

    // create a filesystem on top of Helia, in this case it's UnixFS
    this.fs = unixfs(this.helia);
  }

  /**
   * Stop the IPFS node
   */
  public async stop() {
    await stop(this.helia);
    console.log("IPFSNode stopped");
  }

  /**
   * Store data in IPFS.
   *
   * @param data bytes (Uint8Array) to be stored in IPFS
   * @returns CID of the stored data
   */
  public async putBytes(data: Uint8Array): Promise<string> {
    if (!this.fs) throw new Error("IPFSNode not started");

    // add bytes to the helia node and receive a unique content identifier
    const cid = await this.fs.addBytes(data);

    console.log("IPFSNode put", cid.toString());

    return cid.toString();
  }

  /**
   * Retrieve data from IPFS.
   *
   * @param cid CID of the data to be retrieved
   * @returns bytes (Uint8Array) data stored in IPFS
   */
  public async getBytes(cid: string): Promise<Uint8Array> {
    if (!this.fs) throw new Error("IPFSNode not started");

    const chunks: Uint8Array[] = [];

    // read the file from the blockstore using the Helia node
    for await (const chunk of this.fs.cat(CID.parse(cid))) {
      chunks.push(chunk);
    }

    // Concatenate all chunks into a single Uint8Array
    const result = new Uint8Array(
      chunks.reduce((acc, chunk) => acc + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    console.log("IPFSNode get", cid);

    return result;
  }

  /**
   * @param data string to be stored in IPFS
   * @returns CID of the stored data
   * @note lossy binary data conversion
   */
  public async putString(data: string): Promise<string> {
    const bytes = new TextEncoder().encode(data);
    return await this.putBytes(bytes);
  }

  /**
   * @param cid CID of the data to be retrieved
   * @returns string data from IPFS
   * @note lossy binary data conversion
   */
  public async getString(cid: string): Promise<string> {
    const bytes = await this.getBytes(cid);
    return new TextDecoder().decode(bytes);
  }
}
