// Runnable example for the Meridian Go client.
//
// Start the proxy first (from the repo root):
//
//	cp .env.example .env   # set MERIDIAN_PROXY_TOKEN, GITHUB_TOKEN
//	docker compose up -d
//
// Then run this:
//
//	cd clients/go
//	MERIDIAN_PROXY_TOKEN=... go run ./example
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/Raghaverma/meridianjs/clients/go/meridian"
)

func main() {
	target := envOr("MERIDIAN_PROXY_ADDR", "127.0.0.1:4242")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	c, err := meridian.Dial(ctx, target, meridian.WithToken(os.Getenv("MERIDIAN_PROXY_TOKEN")))
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer c.Close()

	// 1) Unauthenticated liveness + capability probe.
	health, err := c.Health(ctx)
	if err != nil {
		log.Fatalf("health: %v (is the proxy running on %s?)", err, target)
	}
	fmt.Printf("proxy status=%s, %d providers available\n", health.GetStatus(), len(health.GetProviders()))

	// 2) A real normalized call. Same shape for any of the 46 providers — only
	//    the provider name and endpoint change.
	resp, err := c.Get(ctx, "github", "/repos/octocat/Hello-World")
	if err != nil {
		// Errors are normalized across every provider.
		var me *meridian.Error
		if ok := asMeridianError(err, &me); ok {
			log.Fatalf("github call failed: %s (retryable=%t)", me.GetMessage(), me.Retryable())
		}
		log.Fatalf("github call failed: %v", err)
	}

	var repo struct {
		FullName string `json:"full_name"`
		Stars    int    `json:"stargazers_count"`
	}
	if err := resp.Decode(&repo); err != nil {
		log.Fatalf("decode: %v", err)
	}
	fmt.Printf("%s — %d stars\n", repo.FullName, repo.Stars)

	if meta := resp.Meta; meta != nil {
		fmt.Printf("request_id=%s, provider=%s\n", meta.GetRequestId(), meta.GetProvider())
		if rl := meta.GetRateLimit(); rl != nil {
			fmt.Printf("rate limit: %d/%d remaining\n", rl.GetRemaining(), rl.GetLimit())
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// asMeridianError is a tiny stand-in for errors.As to keep the example's intent
// obvious without extra imports.
func asMeridianError(err error, target **meridian.Error) bool {
	if me, ok := err.(*meridian.Error); ok {
		*target = me
		return true
	}
	return false
}
