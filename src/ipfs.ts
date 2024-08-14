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

  public async stop() {
    await stop(this.helia);
    // console.log("IPFSNode stopped");
  }

  public async put(data: string) {
    if (!this.fs) throw new Error("IPFSNode not started");

    // this TextEncoder will turn strings into Uint8Arrays
    const encoder = new TextEncoder();

    // add the bytes to your node and receive a unique content identifier
    const cid = await this.fs.addBytes(encoder.encode(data));

    console.log("IPFSNode put file:", cid.toString());

    return cid.toString();
  }

  public async get(cid: string) {
    if (!this.fs) throw new Error("IPFSNode not started");

    // this decoder will turn Uint8Arrays into strings
    const decoder = new TextDecoder();

    let text = "";
    // read the file from the blockstore using the Helia node
    for await (const chunk of this.fs.cat(CID.parse(cid))) {
      text += decoder.decode(chunk, {
        stream: true,
      });
    }

    console.log("IPFSNode get file:", cid);

    return text;
  }
}
