package main

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

type App struct {
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
	ID      int    `cbor:"id,omitempty"`
}

type CommandResponse struct {
	Status string      `cbor:"status"`
	Data   interface{} `cbor:"data"`
	ID     int         `cbor:"id,omitempty"`
}

func NewApp() *App {
	return &App{
		cmd: exec.Command(
			"pnpm", "run", "agent",
			"--admin",
			"--key", "/tmp/admin.key",
			"--socket-format", "cbor",
			"--listen"),
	}
}

func (app *App) launch() error {
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

func (app *App) onData(c *nbio.Conn, data []byte) {
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

func (app *App) terminate() error {
	fmt.Println("Terminating the process")
	if app.client != nil {
		app.client.Stop()
	}

	if err := app.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		return err
	}

	// the process should cleanup, but make sure
	os.Remove(app.socketFile)

	return nil
}

func (app *App) command(command string) (CommandResponse, error) {
	var response CommandResponse

	// Generate a unique ID for the request
	app.mu.Lock()
	reqID := app.idCounter
	app.idCounter++
	app.mu.Unlock()

	req := CommandRequest{
		Command: command,
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

func main() {
	app := NewApp()

	if err := app.launch(); err != nil {
		log.Fatal(err)
	}

	fmt.Println("Socket file:", app.socketFile)

	defer app.terminate()

	sendCommand := func(command string) {
		response, err := app.command(command)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("Response (%s): %+v\n", command, response)
	}

	sendCommand("token getBalance")
	sendCommand("faucet getEnabled")
	sendCommand("faucet setEnabled 0")
	sendCommand("faucet getEnabled")
	sendCommand("faucet setEnabled 1")
	sendCommand("faucet getEnabled")

	// excute many commands and wait for them all to complete
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sendCommand(fmt.Sprintf("unknown-command-%d", i))
		}(i)
	}
	wg.Wait()
}
