#!/usr/bin/env node --experimental-specifier-resolution=node --experimental-vm-modules --experimental-wasm-modules --experimental-wasm-threads

import * as fs from "fs/promises";
import * as net from "net";
import cbor from "cbor";
import { Command, Option } from "commander";
import { Bool, PrivateKey, PublicKey, UInt64 } from "o1js";
import { client, getTxnState, getTxnStatus } from "chain";
import { IPFSNode } from "./ipfs";

type CommandRequest = {
  command: string; // command fed to the commander program
  payload?: string; // additional binary data unsuitable for transmission within `command` string
  id?: number; // optional id to echo within the corresponding response
};

type CommandResponse = {
  status: "SUCCESS" | "FAILURE" | "PENDING";
  data: any;
  id?: number; // the id from the corresponding request, if it had one
};

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
  .option("--tx-status-retries <retries>", "status check retries", "10");

// peek at program options (and set types)
let opts = {
  help: process.argv.includes("--help") || process.argv.includes("-h"),
  admin: process.argv.includes("--admin"),
  listen: process.argv.includes("--listen"),
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
const nodes = client.runtime.resolve("Nodes");
const token = client.runtime.resolve("Token");

// helper function to send transactions
const txer = async (txfn: () => void): Promise<CommandResponse> => {
  const tx = await client.transaction(publicKey, txfn);
  console.log("tx.nonce", tx.transaction!.nonce.toString());
  tx.transaction = tx.transaction?.sign(privateKey);
  await tx.send();

  if (tx.transaction) {
    console.log("tx.hash", tx.transaction.hash().toString());
    const status = await getTxnStatus(
      tx.transaction,
      () => {
        console.log("⏳ waiting for tx to be confirmed...");
      },
      parseInt(opts.txStatusInterval),
      parseInt(opts.txStatusRetries),
    );
    console.log("tx", status);
    return {
      status: status.status,
      data: status.statusMessage,
    };
  }

  return { status: "PENDING", data: "Transaction unknown status" };
};

////////////////////////////////////////////////////////////////////////
// Commands
////////////////////////////////////////////////////////////////////////

const executeCommand = async (
  program: Command,
  request: CommandRequest,
  callback: (response: CommandResponse) => void,
) => {
  const { command, payload, id } = request;

  if (opts.admin) {
    const commandAdmin = program
      .command("admin")
      .description("appchain administration commands");
    commandAdmin
      .command("getAdmin")
      .description("[admin] get the chain admin")
      .action(async () => {
        const a = await client.query.runtime.Admin.admin.get();
        callback({ id, status: "SUCCESS", data: a?.toBase58() });
      });
    commandAdmin
      .command("setAdmin <admin>")
      .description("[admin] set the chain admin")
      .action(async (newAdmin: string) => {
        const r = await txer(() => {
          admin.setAdmin(PublicKey.fromBase58(newAdmin));
        });
        callback({ id, ...r });
      });
  }

  program
    .command("generateKey")
    .description("generate a new public/private key pair")
    .action(() => {
      const key = PrivateKey.random();
      const data = {
        publicKey: key.toPublicKey().toBase58(),
        privateKey: key.toBase58(),
      };
      callback({ id, status: "SUCCESS", data });
    });

  const commandFaucet = program
    .command("faucet")
    .description("faucet commands");
  commandFaucet
    .command("drip")
    .description("drip tokens from the faucet")
    .action(async () => {
      console.log("drip tokens from the faucet");
      const r = await txer(() => {
        faucet.drip();
      });
      callback({ id, ...r });
    });
  commandFaucet
    .command("getEnabled")
    .description("get faucet enabled status")
    .action(async () => {
      const enabled = await client.query.runtime.Faucet.enabled.get();
      callback({ id, status: "SUCCESS", data: enabled?.toBoolean() });
    });
  commandFaucet
    .command("getDripAmount")
    .description("get faucet drip amount")
    .action(async () => {
      const amount = await client.query.runtime.Faucet.dripAmount.get();
      callback({ id, status: "SUCCESS", data: `${amount?.toBigInt()}` });
    });
  commandFaucet
    .command("getTreasury")
    .description("get amount of funds in faucet treasury")
    .action(async () => {
      const amount = await client.query.runtime.Faucet.treasury.get();
      callback({ id, status: "SUCCESS", data: `${amount?.toBigInt()}` });
    });
  if (opts.admin) {
    commandFaucet
      .command("setEnabled <enabled>")
      .description("[admin] enable (or disable) faucet (0 or 1)")
      .action(async (enabled: boolean) => {
        const r = await txer(() => {
          faucet.setEnabled(Bool(enabled));
        });
        callback({ id, ...r });
      });
    commandFaucet
      .command("setDripAmount <amount>")
      .description("[admin] set faucet drop amount")
      .action(async (amount: number) => {
        const r = await txer(() => {
          faucet.setDripAmount(UInt64.from(amount));
        });
        callback({ id, ...r });
      });
    commandFaucet
      .command("fundTreasury <amount>")
      .description("[admin] fund faucet treasury")
      .action(async (amount: number) => {
        const r = await txer(() => {
          faucet.fundTreasury(UInt64.from(amount));
        });
        callback({ id, ...r });
      });
    commandFaucet
      .command("defundTreasury")
      .description("[admin] defund faucet treasury")
      .action(async () => {
        const r = await txer(() => {
          faucet.defundTreasury();
        });
        callback({ id, ...r });
      });
  }

  const commandToken = program.command("token").description("token commands");
  commandToken
    .command("transfer <to> <amount>")
    .description("send tokens to another account")
    .action(async (to: string, amount: string) => {
      const r = await txer(() => {
        token.transfer(PublicKey.fromBase58(to), UInt64.from(amount));
      });
      callback({ id, ...r });
    });
  commandToken
    .command("getBalance [account]")
    .description("get the balance of an account (default: user's account)")
    .action(async (account?: string) => {
      const address = account ? PublicKey.fromBase58(account) : publicKey;
      const balance = await client.query.runtime.Token.balances.get(address);
      callback({ id, status: "SUCCESS", data: `${balance?.toBigInt()}` });
    });
  if (opts.admin) {
    commandToken
      .command("mint <to> <amount>")
      .description("[admin] mint tokens")
      .action(async (to: PublicKey, amount: number) => {
        const r = await txer(() => {
          token.mint(to, UInt64.from(amount));
        });
        callback({ id, ...r });
      });
  }

  const commandNodes = program.command("nodes").description("nodes commands");
  commandNodes
    .command("isRegistrationOpen")
    .description("get node registration open status")
    .action(async () => {
      const open = await client.query.runtime.Nodes.registrationOpen.get();
      callback({ id, status: "SUCCESS", data: open?.toBoolean() });
    });
  commandNodes
    .command("register")
    .description("register a node with this user's public key")
    .action(async () => {
      const r = await txer(() => {
        nodes.register();
      });
      callback({ id, ...r });
    });
  commandNodes
    .command("getRegistrationStake")
    .description("get amount of tokens required to stake for registration")
    .action(async () => {
      const amount = await client.query.runtime.Nodes.registrationStake.get();
      callback({ id, status: "SUCCESS", data: `${amount?.toBigInt()}` });
    });
  commandNodes
    .command("getTreasury")
    .description("get amount of funds in nodes treasury")
    .action(async () => {
      const amount = await client.query.runtime.Nodes.treasury.get();
      callback({ id, status: "SUCCESS", data: `${amount?.toBigInt()}` });
    });
  if (opts.admin) {
    commandNodes
      .command("openRegistration")
      .description("[admin] open node registration")
      .action(async () => {
        const r = await txer(() => {
          nodes.openRegistration();
        });
        callback({ id, ...r });
      });
    commandNodes
      .command("closeRegistration")
      .description("[admin] close node registration")
      .action(async () => {
        const r = await txer(() => {
          nodes.closeRegistration();
        });
        callback({ id, ...r });
      });
    commandNodes
      .command("setRegistrationStake <amount>")
      .description("[admin] set registration stake")
      .action(async (amount: number) => {
        const r = await txer(() => {
          nodes.setRegistrationStake(UInt64.from(amount));
        });
        callback({ id, ...r });
      });
    commandNodes
      .command("fundTreasury <amount>")
      .description("[admin] fund nodes treasury")
      .action(async (amount: number) => {
        const r = await txer(() => {
          nodes.fundTreasury(UInt64.from(amount));
        });
        callback({ id, ...r });
      });
    commandNodes
      .command("defundTreasury")
      .description("[admin] defund nodes treasury")
      .action(async () => {
        const r = await txer(() => {
          nodes.defundTreasury();
        });
        callback({ id, ...r });
      });
  }

  const commandAux = program
    .command("_")
    .description("Additional commands not part of appchain runtime");
  commandAux
    .command("getTxnState <hash>")
    .description("get the state of a transaction")
    .action(async (hash: string) => {
      try {
        const state = await getTxnState(hash);
        return callback({ id, status: "SUCCESS", data: state });
      } catch (err: any) {
        return callback({
          id,
          status: "FAILURE",
          data: `Error: ${err.message}`,
        });
      }
    });

  program.configureOutput({
    writeOut: (data) => callback({ id, status: "SUCCESS", data: data.trim() }),
    writeErr: (data) => callback({ id, status: "FAILURE", data: data.trim() }),
  });

  try {
    await program.parseAsync(command.split(" "), { from: "user" });
  } catch (err: any) {
    // ignore "commander exit" to avoid dup output from writeErr
    if (err.message === "commander exit") return;
    callback({ id, status: "FAILURE", data: err.message });
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
  await executeCommand(program, { command, id: 0 }, (res) => {
    console.log(res.data);
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
          await executeCommand(new Command(), req, (res) => {
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
