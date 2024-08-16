package chainbridge

import (
	"bufio"
	"fmt"
	"io"
	"log"
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
	cmd        *exec.Cmd
	socketFile string
	client     *nbio.Engine
	conn       *nbio.Conn
	responses  sync.Map
	mu         sync.Mutex
	idCounter  int
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
}

// NewChainBridge initializes a ChainBridge instance. It accepts either:
// - a socket path or
// - a command with its arguments to launch the process.
func NewChainBridge(socketFileOrCommandName string, commandArgs ...string) *ChainBridge {
	var cmd *exec.Cmd
	if len(commandArgs) > 0 {
		cmd = exec.Command(socketFileOrCommandName, commandArgs...)
	}

	return &ChainBridge{
		cmd:        cmd,
		socketFile: socketFileOrCommandName,
	}
}

// Launch starts the ChainBridge either by:
// - connecting to the existing socket path or
// - executing the provided command, then connecting to the socket path printed in its stdout.
func (app *ChainBridge) Launch() error {
	if app.cmd != nil {
		stdout, err := app.cmd.StdoutPipe()
		if err != nil {
			return err
		}
		stderr, err := app.cmd.StderrPipe()
		if err != nil {
			return err
		}

		if err := app.cmd.Start(); err != nil {
			return err
		}

		// Read the socket location from stdout
		outScanner := bufio.NewScanner(io.MultiReader(stdout, stderr))
		for outScanner.Scan() {
			line := outScanner.Text()
			fmt.Println(line)
			const prefix = "UNIX_SOCKET_PATH="
			if strings.HasPrefix(line, prefix) {
				app.socketFile = strings.TrimPrefix(line, prefix)
				break
			}
		}
		if err := outScanner.Err(); err != nil {
			return err
		}

		if app.socketFile == "" {
			return fmt.Errorf("socket path not found in output")
		}
	}

	app.client = nbio.NewEngine(nbio.Config{})
	app.client.OnData(app.onData)

	if err := app.client.Start(); err != nil {
		return fmt.Errorf("nbio client start failed: %v", err)
	}

	conn, err := nbio.Dial("unix", app.socketFile)
	if err != nil {
		return fmt.Errorf("Dial error: %v", err)
	}
	app.conn, err = app.client.AddConn(conn)
	if err != nil {
		return fmt.Errorf("AddConn error: %v", err)
	}

	return nil
}

func (app *ChainBridge) onData(c *nbio.Conn, data []byte) {
	var response CommandResponse
	if err := cbor.Unmarshal(data, &response); err != nil {
		log.Printf("CBOR Unmarshal error: %v\n", err)
		return
	}

	// Dispatch the response to the correct channel
	if ch, ok := app.responses.Load(response.ID); ok {
		ch.(chan CommandResponse) <- response
		app.responses.Delete(response.ID)
	}
}

func (app *ChainBridge) Terminate() error {
	fmt.Println("Terminating the process")
	if app.client != nil {
		app.client.Stop()
	}

	if app.cmd != nil {
		if err := app.cmd.Process.Signal(syscall.SIGTERM); err != nil {
			return err
		}
		// the agent process should cleanup, but make sure
		os.Remove(app.socketFile)
	}

	return nil
}

func (app *ChainBridge) Command(command string, payload []byte) (CommandResponse, error) {
	var response CommandResponse

	// Generate a unique ID for the request
	app.mu.Lock()
	reqID := app.idCounter
	app.idCounter++
	app.mu.Unlock()

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
	app.responses.Store(req.ID, responseChan)

	// Send the request
	_, err = app.conn.Write(reqData)
	if err != nil {
		return response, fmt.Errorf("Write error: %w", err)
	}

	// Wait for the response with a timeout
	select {
	case response = <-responseChan:
		return response, nil
	case <-time.After(30 * time.Second):
		app.responses.Delete(req.ID)
		return response, fmt.Errorf("Timeout waiting for response")
	}
}
