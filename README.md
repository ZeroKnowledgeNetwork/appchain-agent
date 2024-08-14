# 0KN AppChain Agent

The 0KN AppChain Agent provides a command-line-interface with full coverage of
0KN's appchain runtime modules. It has a server mode, bridging appchain
functionality to other programming luanguages through a UNIX domain socket.

## Installation

Place this repo next to the `appchain` monorepo.

```
.
├── appchain/
└── appchain-agent/
```

Refer to appchain requirements including Node.js version.

Install dependencies:

```sh
pnpm install
```

## Usage

With the appchain running, execute the agent and refer to the built-in help info
for complete command reference.

```sh
pnpm run agent --help
```

### Server/Client Communications

The default behavior is for the agent to parse the command-line arguments and
exit. Alternatively, a listen mode (enabled with `--listen`) instructs the agent
to run as a server that continually handles commands through a UNIX socket.

Both modes use the same command and argument format. In server mode, binary
payload data may accompany some commands.

#### Client Examples

Refer to [example-clients](example-clients/) for client examples written in
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

Example:

```json
{
  "status": "SUCCESS",
  "data": 1000
  "id": 123
}
```
