package main

import (
	"fmt"
	"log"
	"sync"

	"github.com/0KnowledgeNetwork/appchain-agent/clients/go/chainbridge"
)

// This is an example appchain agent client that uses the chainbridge go package
// to interact with the appchain.

func main() {
	// Either launch the agent with the command and its arguments
	chainbridge := chainbridge.NewChainBridge(
		"pnpm", "run", "agent",
		"--admin",
		"--key", "/tmp/admin.key",
		"--listen",
		"--socket-format", "cbor",
	)
	// Or simply connect to the existing socket file
	// chainbridge := chainbridge.NewChainBridge("/tmp/appchain.sock")

	// Optionally set an error handler for errors not returned by functions
	chainbridge.SetErrorHandler(func(err error) {
		log.Printf("Error: %v", err)
	})

	chainbridge.SetLogHandler(func(message string) {
		log.Printf("chainbridge: %s", message)
	})

	if err := chainbridge.Launch(); err != nil {
		log.Fatal(err)
	}

	defer chainbridge.Terminate()

	sendCommand := func(command string, payload []byte) {
		response, err := chainbridge.Command(command, payload)
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
