package main

import (
	"fmt"
	"log"
	"sync"

	"appchain/chainbridge"
)

func main() {
	// Either launch the agent with the command and its arguments
	app := chainbridge.NewChainBridge(
		"pnpm", "run", "agent",
		"--admin",
		"--key", "/tmp/admin.key",
		"--listen",
		"--socket-format", "cbor",
	)
	// Or simply connect to the existing socket file
	// app := chainbridge.NewChainBridge("/tmp/appchain.sock")

	if err := app.Launch(); err != nil {
		log.Fatal(err)
	}

	defer app.Terminate()

	sendCommand := func(command string, payload []byte) {
		response, err := app.Command(command, payload)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("Response (%s): %+v\n", command, response)
	}

	sendCommand("token getBalance", nil)
	sendCommand("faucet getEnabled", nil)
	sendCommand("faucet setEnabled 0", nil)
	sendCommand("faucet getEnabled", nil)
	sendCommand("faucet setEnabled 1", nil)
	sendCommand("faucet getEnabled", nil)

	// excute many commands and wait for them all to complete
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sendCommand(fmt.Sprintf("unknown-command-%d", i), nil)
		}(i)
	}
	wg.Wait()
}
