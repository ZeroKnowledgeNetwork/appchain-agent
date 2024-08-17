package chainbridge

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/lesismal/nbio"
)

type ChainBridge struct {
	cmd          *exec.Cmd
	socketFile   string
	client       *nbio.Engine
	conn         *nbio.Conn
	responses    sync.Map
	idCounter    int
	errorHandler func(error)
	logHandler   func(string)
	dialRetries  int
	dialTimeout  time.Duration
	cmdTimeout   time.Duration
	reconnect    bool
	isConnected  bool

	idCounterMu   sync.Mutex
	isConnectedMu sync.Mutex
	reconnectMu   sync.Mutex
}

type CommandRequest struct {
	Command string `cbor:"command"`
	Payload []byte `cbor:"payload,omitempty"`
	ID      int    `cbor:"id,omitempty"`
}

type CommandResponse struct {
	Status string      `cbor:"status"`
	Data   interface{} `cbor:"data"`
	ID     int         `cbor:"id,omitempty"`
	TX     string      `cbor:"tx,omitempty"`
}

// Initialize a ChainBridge instance. Accepts either:
// - a socket path or
// - a command with its arguments to launch the process.
func NewChainBridge(socketFileOrCommandName string, commandArgs ...string) *ChainBridge {
	var cmd *exec.Cmd
	if len(commandArgs) > 0 {
		cmd = exec.Command(socketFileOrCommandName, commandArgs...)
	}

	return &ChainBridge{
		cmd:         cmd,
		socketFile:  socketFileOrCommandName,
		dialRetries: 10,
		dialTimeout: 3 * time.Second,
		cmdTimeout:  10 * time.Second,
		reconnect:   true,
		isConnected: false,
	}
}

// Set a custom error handler to be called when an error occurs.
func (c *ChainBridge) SetErrorHandler(handler func(error)) {
	c.errorHandler = handler
}

// Set a custom log handler to be called for non-error logs.
func (c *ChainBridge) SetLogHandler(handler func(string)) {
	c.logHandler = handler
}

func (c *ChainBridge) handleError(err error) {
	if c.errorHandler != nil {
		c.errorHandler(err)
	}
}

func (c *ChainBridge) log(message string) {
	if c.logHandler != nil {
		c.logHandler(message)
	}
}

func (c *ChainBridge) connectToSocket() error {
	for i := 0; i < c.dialRetries; i++ {
		c.log(fmt.Sprintf("Attempting to connect to socket: %s (attempt %d/%d)", c.socketFile, i+1, c.dialRetries))
		conn, err := nbio.DialTimeout("unix", c.socketFile, c.dialTimeout)
		if err == nil {
			c.conn, err = c.client.AddConn(conn)
			if err == nil {
				c.log("Successfully connected to socket.")
				c.isConnectedMu.Lock()
				c.isConnected = true
				c.isConnectedMu.Unlock()
				return nil
			}
		}
		if !c.reconnect {
			return nil
		}
		c.log(fmt.Sprintf("Failed to connect to socket: %v", err))
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("Failed to connect after %d attempts", c.dialRetries)
}

// Start the ChainBridge either by:
// - connecting to the existing socket path or
// - executing the provided command, then connecting to the socket path printed in its stdout.
func (c *ChainBridge) Start() error {
	c.log("Starting...")

	if c.cmd != nil {
		stdout, err := c.cmd.StdoutPipe()
		if err != nil {
			return err
		}
		stderr, err := c.cmd.StderrPipe()
		if err != nil {
			return err
		}

		if err := c.cmd.Start(); err != nil {
			return err
		}

		// Read the socket location from stdout
		outScanner := bufio.NewScanner(io.MultiReader(stdout, stderr))
		for outScanner.Scan() {
			line := outScanner.Text()
			const prefix = "UNIX_SOCKET_PATH="
			if strings.HasPrefix(line, prefix) {
				c.socketFile = strings.TrimPrefix(line, prefix)
				break
			}
		}
		if err := outScanner.Err(); err != nil {
			return err
		}

		if c.socketFile == "" {
			return fmt.Errorf("socket path not found in output")
		}
	}

	c.client = nbio.NewEngine(nbio.Config{})
	c.client.OnData(c.onData)
	c.client.OnClose(c.onClose)

	if err := c.client.Start(); err != nil {
		return fmt.Errorf("nbio client start failed: %v", err)
	}

	c.reconnectMu.Lock()
	c.reconnect = true
	c.reconnectMu.Unlock()

	return c.connectToSocket()
}

func (c *ChainBridge) onData(conn *nbio.Conn, data []byte) {
	var response CommandResponse
	if err := cbor.Unmarshal(data, &response); err != nil {
		c.handleError(fmt.Errorf("CBOR Unmarshal error: %w", err))
		return
	}

	// Dispatch the response to the correct channel
	if ch, ok := c.responses.Load(response.ID); ok {
		ch.(chan CommandResponse) <- response
		c.responses.Delete(response.ID)
	}
}

func (c *ChainBridge) onClose(conn *nbio.Conn, err error) {
	c.isConnectedMu.Lock()
	c.isConnected = false
	c.isConnectedMu.Unlock()

	c.log("Connection closed")

	if c.reconnect {
		if err := c.connectToSocket(); err != nil {
			c.handleError(fmt.Errorf("Failed to reconnect: %w", err))
		}
	}
}

func (c *ChainBridge) Stop() error {
	c.log("Stopping...")

	c.reconnectMu.Lock()
	c.reconnect = false
	c.reconnectMu.Unlock()

	if c.client != nil {
		c.client.Stop()
	}

	if c.cmd != nil {
		if err := c.cmd.Process.Signal(syscall.SIGTERM); err != nil {
			return err
		}
		// the agent process should cleanup, but make sure
		os.Remove(c.socketFile)
	}

	return nil
}

func (c *ChainBridge) Command(command string, payload []byte) (CommandResponse, error) {
	var response CommandResponse

	if !c.isConnected {
		return response, fmt.Errorf("Not connected")
	}

	// Generate a unique ID for the request
	c.idCounterMu.Lock()
	reqID := c.idCounter
	c.idCounter++
	c.idCounterMu.Unlock()

	req := CommandRequest{
		Command: command,
		Payload: payload,
		ID:      reqID,
	}

	reqData, err := cbor.Marshal(req)
	if err != nil {
		return response, fmt.Errorf("CBOR Marshal error: %w", err)
	}

	// Create a response channel and store it in the map
	responseChan := make(chan CommandResponse, 1)
	c.responses.Store(req.ID, responseChan)

	// Send the request
	_, err = c.conn.Write(reqData)
	if err != nil {
		return response, fmt.Errorf("Write error: %w", err)
	}

	// Wait for the response with a timeout
	select {
	case response = <-responseChan:
		return response, nil
	case <-time.After(c.cmdTimeout):
		c.responses.Delete(req.ID)
		return response, fmt.Errorf("Timeout waiting for response to request ID=%d", req.ID)
	}
}
