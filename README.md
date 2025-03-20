# ZKN ZK AppChain Agent

The ZKN AppChain Agent provides a command-line interface and communications
bridge with full coverage of ZKN's appchain runtime modules. It has a server
mode with developing client libraries to connect appchain operations to other
programming languages through a UNIX domain socket.

Optionally, the agent runs a lightweight IPFS node to contribute to a
distributed data availability layer for the appchain. For certain appchain
interactions, the agent seamlessly handles storage and retrieval of data on IPFS
with the data's Content Identifier indexed within the appchain.

## Installation

This project uses local `file:` references to ZKN's
[appchain](https://github.com/ZeroKnowledgeNetwork/appchain) and
[protokit](https://github.com/ZeroKnowledgeNetwork/protokit).

Place the projects in the same directory and ensure alignment of their git refs:

```
.
├── appchain/
├── appchain-agent/
└── protokit/
```

Refer to appchain requirements including Node.js version.

### Build Deps & Start Appchain

```sh
cd protokit
npm install
npm run build


cd ../appchain
pnpm install

# build appchain for appchain-agent
pnpm run build --filter chain --filter qry

# run appchain sequencer, for example
pnpm env:inmemory dev --filter chain -- --logLevel DEBUG


cd ../appchain-agent
pnpm install
pnpm run build
```

## Development

Set `appchain` and `protokit` versions within [deps.env](deps.env) for the
working branch so that automated workflows use the correct dependency verions.
For example, for an `appchain-agent` `release/0.1` branch:

```env
APPCHAIN=release/0.1
PROTOKIT=zkn/release/0.1
```

## Usage

Refer to the agent's built-in help system for complete command reference.

```sh
pnpm run agent --help
```

### Server/Client Communications

The default behavior is for the agent to parse the command-line arguments and
exit. Alternatively, a listen mode (enabled with `--listen`) instructs the agent
to run as a server that continually handles commands through a UNIX socket.

Both modes use the same command and argument format. In server mode, binary
payload data may accompany some commands.

#### Client Libraries and Examples

Refer to [clients](clients/) for client libraries and examples written in
various languages. If the client launches the appchain agent, it must run in an
environment supporting the agent (with correct node version, etc).

#### Plain Text Messaging Protocol (--socket-format text)

Communication with the agent server may use a simple text format that closely
matches the command-line interface.

#### CBOR Messaging Protocol (--socket-format cbor)

Communications between the client and server are most effectively conducted
using a custom protocol using CBOR (Concise Binary Object Representation)
message format, providing a structured way for the client and server to
communicate commands and responses.

- The client initiates communication by sending a `CommandRequest` message to
  the server. The `command` field specifies the action to be performed,
  additional `payload` data may be included, and an optional `id` field may be
  provided to uniquely match the request to a response.
- The server processes the `CommandRequest` and responds with a
  `CommandResponse` message. The response includes a `status` field indicating
  the result of the command, a `data` field containing any relevant data, and an
  optional `id` field if the original request included one.
- The `id` field in both request and response messages allows for correlation
  between requests and their corresponding responses, especially in scenarios
  where multiple requests are handled concurrently as the order in which
  responses are sent are independent of the order in which requests are
  received.

##### CommandRequest

The `CommandRequest` message is used by the client to send a command to the
server. It consists of the following fields:

- `command` (string): The command to be executed. This is a mandatory field.
- `payload` (any): Additional binary data.
- `id` (integer, optional): An optional identifier for the request.

Example:

```json
{
  "command": "token getBalance",
  "id": 123
}
```

##### CommandResponse

The `CommandResponse` message is used by the server to send the result of a
command execution back to the client. It contains the following fields:

- `status` (string): The status of the command execution. This can be one of the
  following values:
  - `"SUCCESS"`: The command was executed successfully.
  - `"FAILURE"`: The command execution failed.
  - `"PENDING"`: The command execution is still in progress.
- `data` (any): The data returned by the command execution. The type and content
  of this field depend on the specific command and its result.
- `id` (integer, optional): The identifier for the request that this response
  corresponds to.
- `tx` (string, optional): The transaction hash, if the command had one

Example:

```json
{
  "status": "SUCCESS",
  "data": 1000
  "id": 123
}
```
