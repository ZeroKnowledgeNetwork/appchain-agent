#!/usr/bin/env node --experimental-specifier-resolution=node --experimental-vm-modules --experimental-wasm-modules --experimental-wasm-threads

import * as fs from "fs/promises";
import * as net from "net";
import cbor from "cbor";
import { Command, Option } from "commander";
import {
  Bool,
  CircuitString,
  Field,
  Poseidon,
  PrivateKey,
  PublicKey,
} from "o1js";
import {
  Balance,
  CID,
  MixDescriptor,
  Network,
  Node,
  TreasuryId,
  client,
  getTxnState,
  getTxnStatus,
} from "chain";
import { IPFSNode } from "./ipfs";

type CommandRequest = {
  command: string; // command fed to the commander program
  payload?: Uint8Array; // additional binary data unsuitable for transmission within `command` string
  id?: number; // optional id to echo within the corresponding response
};

type CommandResponse = {
  status: "SUCCESS" | "FAILURE" | "PENDING";
  data?: any;
  error?: string; // error message, if status is "FAILURE"
  id?: number; // the id from the corresponding request, if it had one
  tx?: string; // the hash of the transaction, if it had a transaction
};

// pragmatic helpers to avoid typos
const SUCCESS = "SUCCESS";
const FAILURE = "FAILURE";
const PENDING = "PENDING";

// Reads and returns a private key from a file.
// If the file does not exist, generate a new private key, save it to the file, then return it.
const getPrivateKeyFromFile = async (path: string): Promise<PrivateKey> => {
  try {
    const privateKey = await fs.readFile(path, "utf8");
    return PrivateKey.fromBase58(privateKey);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      const privateKey = PrivateKey.random();
      await fs.writeFile(path, privateKey.toBase58());
      return privateKey;
    } else {
      throw e;
    }
  }
};

const getBytesFromFile = async (path: string): Promise<Uint8Array> => {
  const f = path.replace(/^file:\/\//, "");
  return await fs.readFile(f);
};

const putBytesToFile = async (
  path: string,
  data: Uint8Array,
): Promise<void> => {
  const f = path.replace(/^file:\/\//, "");
  return await fs.writeFile(f, data);
};

const program = new Command();
program.name("cli").description("appchain cli");

program
  .option("--admin", "enable admin commands", false)
  .option("--listen", "listen for commands on a socket", false)
  .option("--key <key>", "path to private key", "/tmp/appchain.key")
  .addOption(
    new Option("--socket <path>", "path to UNIX socket")
      .default("/tmp/appchain.sock")
      .implies({ listen: true }),
  )
  .addOption(
    new Option("--socket-format <format>", "socket IO format")
      .default("text")
      .choices(["text", "cbor"]),
  )
  .option("--debug", "print additional logs", false)
  .option("--nonce", "[listen] use internally tracked nonce", false)
  .option("--ipfs", "enable IPFS node", false)
  .option(
    "--ipfs-data <path>",
    "path to IPFS data storage directory",
    "/tmp/appchain-data",
  )
  .option(
    "--tx-status-interval <interval>",
    "status check interval (ms)",
    "1000",
  )
  .option(
    "--tx-status-retries <retries>",
    "status check retries (use 0 to disable)",
    "10",
  );

// peek at program options (and set types)
let opts = {
  help: process.argv.includes("--help") || process.argv.includes("-h"),
  admin: process.argv.includes("--admin"),
  listen: process.argv.includes("--listen"),
  debug: process.argv.includes("--debug"),
  nonce: process.argv.includes("--nonce"),
  ipfs: process.argv.includes("--ipfs"),
  key: "",
  socket: "",
  socketFormat: "",
  ipfsData: "",
  txStatusInterval: "",
  txStatusRetries: "",
};

let privateKey: PrivateKey;
let publicKey: PublicKey;

if (!opts.help) {
  program.parse();
  opts = program.opts();

  privateKey = await getPrivateKeyFromFile(opts.key);
  publicKey = privateKey.toPublicKey();
  console.log(`Using key from ${opts.key}:`, publicKey.toBase58());
}

console.log("opts", opts);

// fire up the appchain client!
await client.start();
const admin = client.runtime.resolve("Admin");
const faucet = client.runtime.resolve("Faucet");
const networks = client.runtime.resolve("Networks");
const nodes = client.runtime.resolve("Nodes");
const pki = client.runtime.resolve("Pki");
const token = client.runtime.resolve("Token");

// helper function to send transactions
let nonce: number | undefined;
const txer = async (txfn: () => Promise<void>): Promise<CommandResponse> => {
  const tx = await client.transaction(publicKey, txfn, { nonce });
  console.log("tx.nonce", tx.transaction!.nonce.toString());
  tx.transaction = tx.transaction?.sign(privateKey);
  await tx.send();

  if (tx.transaction) {
    // client.transaction will fetch nonce from the chain if not given as an option.
    // An internally tracked nonce only works for one agent instance per public key
    // but enables submission of many txns without waiting for their confirmation.
    if (opts.nonce) nonce = Number(tx.transaction.nonce) + 1;

    const { status, statusMessage } = await getTxnStatus(
      tx.transaction,
      () => {
        console.log("⏳ waiting for tx to be confirmed...");
      },
      parseInt(opts.txStatusInterval),
      parseInt(opts.txStatusRetries),
    );
    return {
      status,
      data: status !== FAILURE ? statusMessage : undefined,
      error: status === FAILURE ? statusMessage : undefined,
      tx: tx.transaction.hash().toString(),
    };
  }

  return { status: PENDING };
};

////////////////////////////////////////////////////////////////////////
// Commands
////////////////////////////////////////////////////////////////////////

const executeCommand = async (
  program: Command,
  request: CommandRequest,
  callback: (response: CommandResponse, debug?: any) => void,
) => {
  const { command, payload, id } = request;

  // common responses
  const responses: Record<string, CommandResponse> = {
    IPFS_NOT_STARTED: { id, status: FAILURE, error: "IPFS node not started" },
    PAYLOAD_UNDEFINED: { id, status: FAILURE, error: "Payload undefined" },
    RECORD_NOT_FOUND: { id, status: SUCCESS, data: undefined },
  };

  if (opts.admin) {
    const commandAdmin = program
      .command("admin")
      .description("appchain administration commands");
    commandAdmin
      .command("getAdmin")
      .description("[admin] get the chain admin")
      .action(async () => {
        const a = await client.query.runtime.Admin.admin.get();
        callback({ id, status: SUCCESS, data: a?.toBase58() });
      });
    commandAdmin
      .command("setAdmin [key]")
      .description("[admin] set the chain admin (default: user's key)")
      .action(async (key?: string) => {
        const newAdmin = key ? PublicKey.fromBase58(key) : publicKey;
        const r = await txer(async () => {
          await admin.setAdmin(newAdmin);
        });
        callback({ id, ...r });
      });
  }

  const commandFaucet = program
    .command("faucet")
    .description("faucet commands");
  commandFaucet
    .command("drip")
    .description("drip tokens from the faucet")
    .action(async () => {
      const r = await txer(async () => {
        await faucet.drip();
      });
      callback({ id, ...r });
    });
  commandFaucet
    .command("getEnabled")
    .description("get faucet enabled status")
    .action(async () => {
      const enabled = await client.query.runtime.Faucet.enabled.get();
      callback({ id, status: SUCCESS, data: enabled?.toBoolean() });
    });
  commandFaucet
    .command("getDripAmount")
    .description("get faucet drip amount")
    .action(async () => {
      const amount = await client.query.runtime.Faucet.dripAmount.get();
      callback({ id, status: SUCCESS, data: amount?.toString() });
    });
  commandFaucet
    .command("getTreasury")
    .description("get amount of funds in faucet treasury")
    .action(async () => {
      const treasuryId = client.runtime.config.Faucet!.treasuryId;
      const treasuryKey = TreasuryId.toPublicKey(treasuryId);
      const amount = await client.query.runtime.Token.ledger.get(treasuryKey);
      callback({ id, status: SUCCESS, data: amount?.toString() });
    });
  if (opts.admin) {
    commandFaucet
      .command("setEnabled <enabled>")
      .description("[admin] enable (or disable) faucet (0 or 1)")
      .action(async (enabled: boolean) => {
        const r = await txer(async () => {
          await faucet.setEnabled(Bool(enabled));
        });
        callback({ id, ...r });
      });
    commandFaucet
      .command("setDripAmount <amount>")
      .description("[admin] set faucet drop amount")
      .action(async (amount: number) => {
        const r = await txer(async () => {
          await faucet.setDripAmount(Balance.from(amount));
        });
        callback({ id, ...r });
      });
    commandFaucet
      .command("fundTreasury <amount>")
      .description("[admin] fund faucet treasury")
      .action(async (amount: number) => {
        const r = await txer(async () => {
          await faucet.fundTreasury(Balance.from(amount));
        });
        callback({ id, ...r });
      });
  }

  const commandToken = program.command("token").description("token commands");
  commandToken
    .command("transfer <to> <amount>")
    .description("send tokens to another account")
    .action(async (to: string, amount: string) => {
      const r = await txer(async () => {
        await token.transfer(PublicKey.fromBase58(to), Balance.from(amount));
      });
      callback({ id, ...r });
    });
  commandToken
    .command("getBalance [account]")
    .description("get the balance of an account (default: user's account)")
    .action(async (account?: string) => {
      const address = account ? PublicKey.fromBase58(account) : publicKey;
      const balance = await client.query.runtime.Token.ledger.get(address);
      callback({ id, status: SUCCESS, data: balance?.toString() });
    });
  if (opts.admin) {
    commandToken
      .command("mint <to> <amount>")
      .description("[admin] mint tokens")
      .action(async (to: string, amount: number) => {
        const r = await txer(async () => {
          await token.mint(PublicKey.fromBase58(to), Balance.from(amount));
        });
        callback({ id, ...r });
      });
  }

  const commandNetworks = program
    .command("networks")
    .description("networks commands");
  commandNetworks
    .command("register <identifier> [file://]")
    .description("register a network <parameters := file:// OR payload>")
    .action(async (identifier: string, file?: string) => {
      if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);

      // get network parameters from file or payload
      const _payload = file ? await getBytesFromFile(file) : payload;
      if (!_payload) return callback(responses.PAYLOAD_UNDEFINED);

      const parametersCID = await ipfsNode.putBytes(_payload);

      const r = await txer(async () => {
        await networks.register(
          new Network({
            identifier: CircuitString.fromString(identifier),
            parametersCID: CID.fromString(parametersCID),
          }),
        );
      });

      const debug = { identifier, cid: parametersCID, tx: r.tx };
      callback({ id, ...r }, debug);
    });
  commandNetworks
    .command("getActive")
    .description("get the identifier of the active network(s)")
    .action(async () => {
      const nid = (await client.query.runtime.Networks.activeNetwork.get()) as
        | Field
        | undefined;
      if (!nid) return callback(responses.RECORD_NOT_FOUND);

      // retrieve the string form of the network identifier
      const n = await client.query.runtime.Networks.networks.get(nid);
      if (!n) return callback(responses.RECORD_NOT_FOUND);

      callback({ id, status: SUCCESS, data: n.identifier.toString() });
    });
  commandNetworks
    .command("getNetwork <identifier> [file://]")
    .description(
      'get network by id; "_" for active, optionally save params to file',
    )
    .action(async (identifier: string, file?: string) => {
      if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);

      var networkID: Field;
      if (identifier === "_") {
        const nid =
          (await client.query.runtime.Networks.activeNetwork.get()) as
            | Field
            | undefined;
        if (!nid) return callback(responses.RECORD_NOT_FOUND);
        networkID = nid;
      } else {
        networkID = Network.getID(CircuitString.fromString(identifier));
      }

      const network = (await client.query.runtime.Networks.networks.get(
        networkID,
      )) as Network | undefined;
      if (!network) return callback(responses.RECORD_NOT_FOUND);

      const cid = network.parametersCID.toString();
      const parameters = await ipfsNode.getBytes(cid);
      if (file) await putBytesToFile(file, parameters);

      const { parametersCID, ...rest } = Network.toObject(network);
      const data = {
        parameters,
        ...rest,
      };

      const debug = { identifier, cid, network: rest };
      callback(
        {
          id,
          status: SUCCESS,
          data: opts.socketFormat === "cbor" ? cbor.encode(data) : data,
        },
        debug,
      );
    });
  commandNetworks
    .command("setActive <identifier>")
    .description("set the active network")
    .action(async (identifier: string) => {
      const networkID = Network.getID(CircuitString.fromString(identifier));
      const r = await txer(async () => {
        await networks.setActiveNetwork(networkID);
      });
      callback({ id, ...r });
    });

  const commandNodes = program.command("nodes").description("nodes commands");
  commandNodes
    .command("isRegistrationOpen")
    .description("get node registration open status")
    .action(async () => {
      const open = await client.query.runtime.Nodes.registrationOpen.get();
      callback({ id, status: SUCCESS, data: open?.toBoolean() });
    });
  commandNodes
    .command("register <identifier> [isGatewayNode] [isServiceNode]")
    .description("register a node <identityKey := payload>")
    .action(
      async (
        identifier: string,
        isGatewayNode?: boolean,
        isServiceNode?: boolean,
      ) => {
        if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);
        if (!payload) return callback(responses.PAYLOAD_UNDEFINED);

        const identityKeyCID = await ipfsNode.putBytes(payload);

        const r = await txer(async () => {
          await nodes.register(
            new Node({
              administrator: publicKey,
              identifier: CircuitString.fromString(identifier),
              identityKeyCID: CID.fromString(identityKeyCID),
              isGatewayNode: Bool(isGatewayNode ?? false),
              isServiceNode: Bool(isServiceNode ?? false),
            }),
          );
        });

        const debug = { identifier, cid: identityKeyCID, tx: r.tx };
        callback({ id, ...r }, debug);
      },
    );
  commandNodes
    .command("getNode <identifier>")
    .description("get node by identifier")
    .action(async (identifier: string) => {
      if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);
      const nodeID = Node.getID(CircuitString.fromString(identifier));
      const node = (await client.query.runtime.Nodes.nodes.get(nodeID)) as
        | Node
        | undefined;
      if (!node) return callback(responses.RECORD_NOT_FOUND);

      const cid = node.identityKeyCID.toString();
      const identityKey = await ipfsNode.getBytes(cid);

      const { identityKeyCID, ...rest } = Node.toObject(node);
      const data = {
        identityKey,
        ...rest,
      };

      const debug = { identifier, cid, node: rest };
      callback(
        {
          id,
          status: SUCCESS,
          data: opts.socketFormat === "cbor" ? cbor.encode(data) : data,
        },
        debug,
      );
    });
  commandNodes
    .command("getRegistrationStake")
    .description("get amount of tokens required to stake for registration")
    .action(async () => {
      const amount = await client.query.runtime.Nodes.registrationStake.get();
      callback({ id, status: SUCCESS, data: amount?.toString() });
    });
  if (opts.admin) {
    commandNodes
      .command("openRegistration")
      .description("[admin] open node registration")
      .action(async () => {
        const r = await txer(async () => {
          await nodes.openRegistration();
        });
        callback({ id, ...r });
      });
    commandNodes
      .command("closeRegistration")
      .description("[admin] close node registration")
      .action(async () => {
        const r = await txer(async () => {
          await nodes.closeRegistration();
        });
        callback({ id, ...r });
      });
    commandNodes
      .command("setRegistrationStake <amount>")
      .description("[admin] set registration stake")
      .action(async (amount: number) => {
        const r = await txer(async () => {
          await nodes.setRegistrationStake(Balance.from(amount));
        });
        callback({ id, ...r });
      });
  }

  const commandPKI = program.command("pki").description("pki commands");
  commandPKI
    .command("getGenesisEpoch")
    .description("get the genesis epoch")
    .action(async () => {
      const e = await client.query.runtime.Pki.genesisEpoch.get();
      callback({ id, status: SUCCESS, data: e?.toString() });
    });
  commandPKI
    .command("getDocument <epoch>")
    .description("get PKI document for the given epoch")
    .action(async (epoch: number) => {
      if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);

      const cid_ = await client.query.runtime.Pki.documents.get(
        Field.from(epoch),
      );
      if (!cid_) return callback(responses.RECORD_NOT_FOUND);

      // get data from IPFS by cid
      const cid = cid_.toString();
      const data = await ipfsNode.getBytes(cid);

      const debug = { epoch, cid };
      callback({ id, status: SUCCESS, data }, debug);
    });
  // utility: given a mix descriptor identifier,
  // get and callback the descriptor with data
  const pkiGetMixDescriptor = async (did: Field) => {
    if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);

    // get descriptor from appchain
    const d = await client.query.runtime.Pki.mixDescriptors.get(did);
    if (!d) return callback(responses.RECORD_NOT_FOUND);

    // get data from IPFS by cid
    const cid = d.cid.toString();
    const data = await ipfsNode.getBytes(cid);

    const debug = {
      epoch: d.epoch.toString(),
      identifier: d.identifier.toString(),
      did: did.toString(),
      cid,
    };

    callback({ id, status: SUCCESS, data }, debug);
  };
  commandPKI
    .command("getMixDescriptor <epoch> <identifier>")
    .description("get mix descriptor for the given epoch and identifier")
    .action(async (epoch: number, identifier: string) => {
      const did = MixDescriptor.getID(
        Field.from(epoch),
        CircuitString.fromString(identifier),
      );
      return await pkiGetMixDescriptor(did);
    });
  commandPKI
    .command("getMixDescriptorByIndex <epoch> <index>")
    .description("get mix descriptor for the given epoch and index")
    .action(async (epoch: number, index: number) => {
      const did = await client.query.runtime.Pki.mixDescriptorIndex.get(
        Poseidon.hash([Field.from(epoch), Field.from(index)]),
      );
      if (!did) return callback(responses.RECORD_NOT_FOUND);
      return await pkiGetMixDescriptor(did);
    });
  commandPKI
    .command("getMixDescriptorCounter <epoch>")
    .description("get mix descriptor counter for the given epoch")
    .action(async (epoch: number) => {
      const counter = await client.query.runtime.Pki.mixDescriptorCounter.get(
        Field.from(epoch),
      );
      callback({ id, status: SUCCESS, data: counter?.toString() });
    });
  commandPKI
    .command("setDocument <epoch>")
    .description("[listen] set pki document <document := payload>")
    .action(async (epoch: number) => {
      if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);
      if (!payload) return callback(responses.PAYLOAD_UNDEFINED);

      // Note: The payload is used for lossless encoding of binary data.
      // store the doc data on IPFS
      const cid = await ipfsNode.putBytes(payload);

      // register descriptor with appchain
      const r = await txer(async () => {
        await pki.setDocument(Field.from(epoch), CircuitString.fromString(cid));
      });

      const debug = { epoch, cid, tx: r.tx };
      callback({ id, ...r }, debug);
    });
  commandPKI
    .command("setMixDescriptor <epoch> <identifier>")
    .description("[listen] set mix descriptor <descriptor := payload>")
    .action(async (epoch: number, identifier: string) => {
      if (!ipfsNode) return callback(responses.IPFS_NOT_STARTED);
      if (!payload) return callback(responses.PAYLOAD_UNDEFINED);

      // Note: The payload is used for lossless encoding of binary data.
      // store the descriptor data on IPFS
      const cid = await ipfsNode.putBytes(payload);

      // register descriptor with appchain
      const r = await txer(async () => {
        await pki.setMixDescriptor(
          new MixDescriptor({
            epoch: Field.from(epoch),
            identifier: CircuitString.fromString(identifier),
            cid: CircuitString.fromString(cid),
          }),
        );
      });

      const debug = { epoch, identifier, cid, tx: r.tx };
      callback({ id, ...r }, debug);
    });

  const commandAux = program
    .command("_")
    .description("Additional commands not part of appchain runtime");
  commandAux
    .command("generateKey")
    .description("generate a new public/private key pair")
    .action(() => {
      const key = PrivateKey.random();
      const data = {
        publicKey: key.toPublicKey().toBase58(),
        privateKey: key.toBase58(),
      };
      callback({ id, status: SUCCESS, data });
    });
  commandAux
    .command("getTxnState <hash>")
    .description("get the state of a transaction")
    .action(async (hash: string) => {
      const data = await getTxnState(hash);
      callback({ id, status: SUCCESS, data });
    });

  program.configureOutput({
    writeOut: (data) => callback({ id, status: SUCCESS, data: data.trim() }),
    writeErr: (data) => callback({ id, status: FAILURE, error: data.trim() }),
  });

  try {
    await program.parseAsync(command.split(" "), { from: "user" });
  } catch (err: any) {
    // ignore "commander exit" to avoid dup output from writeErr
    if (err.message === "commander exit") return;
    callback({ id, status: FAILURE, error: err.message });
  }
};

////////////////////////////////////////////////////////////////////////
// Start IPFS Node
////////////////////////////////////////////////////////////////////////

let ipfsNode: IPFSNode | undefined;
if (opts.ipfs) {
  ipfsNode = new IPFSNode({ dataPath: opts.ipfsData });
  await ipfsNode.start();
}

////////////////////////////////////////////////////////////////////////
// CLI mode - parse command line arguments and exit
////////////////////////////////////////////////////////////////////////

if (!opts.listen) {
  const command = process.argv.slice(2).join(" ");
  const regex = /^Usage: /;
  await executeCommand(program, { command, id: 0 }, (res, debug) => {
    regex.test(res.data) ? console.log(res.data) : console.log(res);
    if (opts.debug && debug) console.log("DEBUG:", debug);
  });
  if (ipfsNode) await ipfsNode.stop();
  process.exit(0);
}

////////////////////////////////////////////////////////////////////////
// Listen mode - continually handle commands through a UNIX socket
////////////////////////////////////////////////////////////////////////

const socketPath = opts.socket;

// Override exit so Commander doesn't exit the process, for any reason
const ogExit = process.exit;
process.exit = () => {
  throw new Error("commander exit");
};

// Cleanup on exit
const cleanup = async (code: number | undefined) => {
  fs.unlink(socketPath);
  if (ipfsNode) await ipfsNode.stop();
  ogExit(code);
};

process.on("SIGINT", cleanup); // Handle CTRL-C
process.on("SIGTERM", cleanup); // Handle kill commands
process.on("exit", cleanup); // Process exit

// JSON.stringify replacer to limit output length for logs
const rep = (_key: string, value: any) => {
  if (value instanceof Uint8Array) {
    return `Uint8Array(${value.length})...`;
  }
  if (typeof value === "string" && value.length > 100) {
    return value.substring(0, 100) + "...";
  }
  return value;
};

const server = net.createServer((socket) => {
  let id = 0; // simulate id unless provided
  let buffer = Buffer.alloc(0); // Buffer to store incoming data

  socket.on("data", async (data) => {
    if (opts.socketFormat === "text") {
      const req = { command: data.toString().trim(), id: id++ };
      await executeCommand(new Command(), req, (res) => {
        socket.write(JSON.stringify(res) + "\n");
      });
      return;
    }

    if (opts.socketFormat === "cbor") {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length > 0) {
        try {
          const decoded = cbor.decodeFirstSync(buffer, {
            extendedResults: true,
            required: true, // Should an error be thrown when no data is in the input?
          });

          const req = decoded.value as CommandRequest;
          await executeCommand(new Command(), req, (res, debug) => {
            console.log(`\n❯ ${req.command} => ${JSON.stringify(res, rep)}`);
            if (opts.debug && debug) console.log("DEBUG:", debug);
            const out = cbor.encode(res);
            socket.write(out);
          });

          // Remove the processed data from the buffer
          buffer = buffer.subarray(decoded.length);
        } catch (err: any) {
          // If decoding fails, break out of the loop and wait for more data
          break;
        }
      }
      return;
    }
  });
});

server.listen(socketPath, () => {
  console.log(`UNIX_SOCKET_PATH=${socketPath}`);
});
