// Command kitties orchestrates a fleet of autonomous agents, each with its own soul, its own AI
// provider and its own isolated container.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madkoding/kitties/internal/agenda"
	"github.com/madkoding/kitties/internal/approvals"
	"github.com/madkoding/kitties/internal/artifacts"
	"github.com/madkoding/kitties/internal/backup"
	"github.com/madkoding/kitties/internal/boat"
	"github.com/madkoding/kitties/internal/budget"
	"github.com/madkoding/kitties/internal/chat"
	"github.com/madkoding/kitties/internal/config"
	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/demo"
	"github.com/madkoding/kitties/internal/digest"
	"github.com/madkoding/kitties/internal/gateway"
	"github.com/madkoding/kitties/internal/keep"
	"github.com/madkoding/kitties/internal/kitty"
	"github.com/madkoding/kitties/internal/lima"
	"github.com/madkoding/kitties/internal/memory"
	"github.com/madkoding/kitties/internal/notify"
	"github.com/madkoding/kitties/internal/orchestrator"
	"github.com/madkoding/kitties/internal/provider"
	"github.com/madkoding/kitties/internal/selfupdate"
	"github.com/madkoding/kitties/internal/skills"
	"github.com/madkoding/kitties/internal/soul"
	"github.com/madkoding/kitties/internal/statefs"
	"github.com/madkoding/kitties/internal/statelock"
	"github.com/madkoding/kitties/internal/vault"
	"github.com/madkoding/kitties/internal/web"
)

// version is set by the linker (-X main.version=...).
var version = "dev"

const usage = `kitties %s: a fleet of autonomous agents, each with its own soul and desktop.

Usage: kitties [-config file] <command> [arguments]

Commands:
  init                      write an example configuration (and a sample soul) to start from
  gateway [-listen addr]    bootstrap the fleet and serve the HTTP API and the web interface
  restore <directory> [id] restore an encrypted recovery package into an empty directory
  token                     print the gateway's token (to sign in to the web interface)
  ls                        list the kitties and their state
  create <name> [flags]     create a kitty (-provider, -persona, -soul file, -avatar breed/color, -no-desktop)
  start|stop|rm <name>      manage one kitty
  scale <name> <n>          run n replicas of a configured kitty (name-1 ... name-n)
  chat <name>[,<name>...]   talk to one kitty, or to a group of them, from the terminal
  exec <name> <cmd...>      run a command inside the kitty's computer
  shot <name> <file.png>    save a screenshot of the kitty's display
  providers                 list the configured AI profiles and the supported kinds
  version                   print the version
  release-key | release-sign <file> | release-verify <file> <sig> <key>
                            the signing of the releases (for whoever makes them)

Flags: -config file picks the configuration; -demo needs no key and no Docker (a scripted brain
and a drawn desktop) and is the quickest way to see the interface: kitties -demo gateway.
-vm-demo uses a scripted brain with a REAL persistent Lima VM; try asking it to open a URL.

Environment: KITTIES_CONFIG names the configuration file (default ./kitties.yaml or ~/.kitties/kitties.yaml).
A gateway without a configuration file starts empty: add models and kitties from the web page.
For a server, KITTIES_LISTEN, KITTIES_TOKEN, KITTIES_PUBLIC_URL, KITTIES_DATA_DIR and KITTIES_TRUST_PROXY
override the gateway block, which is how a container is configured (see docs/DEPLOY.md).
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// app is the state every command shares.
type app struct {
	backups      *backup.Manager
	configPath   string
	closeRuntime func() error
	stateLock    *statelock.Lock
	remoteState  *statefs.Store
	demo         bool
	vmDemo       bool
	cfg          config.Config
	fleet        *orchestrator.Manager
	chats        *chat.Service
	agenda       *agenda.Agenda
	// approvals hold the actions that wait for a yes; memory is what the kitties know of the
	// person; notifier tells the person outside the interface.
	approvals *approvals.Store
	vault     *vault.Store
	keep      *keep.Store
	updater   *selfupdate.Updater
	// booted is what the start found out about the last update (rolled back, confirmed).
	booted   selfupdate.BootResult
	budget   *budget.Store
	digest   *digest.Reporter
	memory   *memory.Store
	notifier *notify.Notifier
	skills   *skills.Library
	arts     *artifacts.Store
	in       io.Reader
	out      io.Writer
	err      io.Writer
}

// Seams for the tests.
var (
	detectRuntime = container.Detect
	newContainers = func(rt container.Runtime) orchestrator.Containers { return container.New(rt) }
	webFS         = web.FS
	notifyContext = func() (context.Context, context.CancelFunc) {
		return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	}
)

func run(args []string, in io.Reader, out, errOut io.Writer) int {
	fs := flag.NewFlagSet("kitties", flag.ContinueOnError)
	fs.SetOutput(errOut)
	configPath := fs.String("config", "", "configuration file (default: KITTIES_CONFIG, ./kitties.yaml or ~/.kitties/kitties.yaml)")
	demoMode := fs.Bool("demo", false, "no AI key and no Docker: a scripted brain and a drawn desktop, to try the interface")
	vmDemo := fs.Bool("vm-demo", false, "scripted brain with a real persistent Lima desktop (no AI key needed)")
	fs.Usage = func() { fmt.Fprintf(errOut, usage, version) }
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *vmDemo && (*demoMode || *configPath != "") {
		fmt.Fprintln(errOut, "-vm-demo cannot be combined with -demo or -config")
		return 2
	}
	rest := fs.Args()
	if len(rest) == 0 {
		fs.Usage()
		return 2
	}
	cmd, rest := rest[0], rest[1:]
	switch cmd {
	case "version":
		fmt.Fprintln(out, "kitties", version)
		return 0
	case "init":
		return cmdInit(*configPath, out, errOut)
	case "restore":
		return cmdRestore(rest, out, errOut)
	case "restore-gateway":
		return cmdRestoreGateway(rest, out, errOut)
	case "import-state":
		return cmdImportState(rest, out, errOut)
	case "verify-recovery":
		return cmdVerifyRecovery(rest, out, errOut)
	case "release-recovery":
		return cmdReleaseRecovery(rest, out, errOut)
	case "release-key", "release-sign", "release-verify":
		return cmdRelease(cmd, rest, out, errOut)
	case "help", "-h", "--help":
		fs.Usage()
		return 0
	}
	// A gateway that was just updated is counted before anything else can go wrong (even reading
	// the configuration): one that does not hold goes back to the version before.
	var booted selfupdate.BootResult
	if cmd == "gateway" {
		var berr error
		if booted, berr = selfupdate.New(config.Defaults().Updates, version).Boot(); berr != nil {
			fmt.Fprintf(errOut, "kitties: %v\n", berr)
		}
	}
	var remoteState *statefs.Store
	if endpoint := strings.TrimSpace(os.Getenv("KITTIES_STATE_URL")); endpoint != "" {
		dataDir := strings.TrimSpace(os.Getenv("KITTIES_DATA_DIR"))
		if dataDir == "" {
			fmt.Fprintln(errOut, "kitties: KITTIES_STATE_URL requires an explicit KITTIES_DATA_DIR for its disposable cache")
			return 1
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		var err error
		if err = prepareCloudRestore(ctx, endpoint); err == nil {
			remoteState, err = statefs.Open(ctx, dataDir, endpoint)
		}
		if err == nil {
			err = verifyCloudRestore(dataDir)
		}
		cancel()
		if err != nil {
			if remoteState != nil {
				remoteState.Close()
			}
			fmt.Fprintf(errOut, "kitties: open durable gateway state: %v\n", err)
			return 1
		}
		defer remoteState.Close()
	}
	path := restoredConfiguration(*configPath)
	cfg, err := config.Load(path)
	switch {
	case *vmDemo:
		cfg, err = demoConfig()
		cfg.Kitties = cfg.Kitties[:1]
		cfg.Containers.Runtime = "lima"
		cfg.Containers.Image = "lima:debian-13"
		cfg.Containers.MemoryMB = 4096
		cfg.Containers.AutoUpdate = false
		cfg.Updates.Gateway = "off"
		cfg.Gateway.Listen = "127.0.0.1:7489"
		if home, homeErr := os.UserHomeDir(); homeErr == nil {
			cfg.DataDir = filepath.Join(home, ".kitties-lima-demo")
		} else {
			err = homeErr
		}
	case err != nil && *demoMode && *configPath == "":
		// No file of their own: the demo brings its kitties. A file that was named must load.
		cfg, err = demoConfig()
	case err != nil && errors.Is(err, os.ErrNotExist) && *configPath == "" && os.Getenv("KITTIES_CONFIG") == "" && (cmd == "gateway" || cmd == "token"):
		// A server with no file yet: it starts empty and is set up from the web page.
		cfg, err = config.Defaults(), nil
		fmt.Fprintf(errOut, "kitties: no configuration file (%s): starting empty; add models and kitties from the web page\n", path)
	}
	if err == nil {
		err = cfg.ApplyEnv(os.Getenv)
	}
	if err != nil {
		fmt.Fprintf(errOut, "kitties: %v\nRun `kitties init` to write an example configuration.\n", err)
		return 1
	}
	if cmd == "token" {
		return cmdToken(cfg, out, errOut)
	}
	a := &app{cfg: cfg, in: in, out: out, err: errOut, demo: *demoMode, vmDemo: *vmDemo, booted: booted, remoteState: remoteState, configPath: path}
	defer func() { _ = a.close() }()
	if err := a.open(cmd); err != nil {
		fmt.Fprintf(errOut, "kitties: %v\n", err)
		return 1
	}
	if err := a.dispatch(cmd, rest); err != nil {
		fmt.Fprintf(errOut, "kitties: %v\n", err)
		return 1
	}
	return 0
}

// open builds the orchestrator and the chat service; the runtime is probed except for the
// commands that never touch a container.
func (a *app) open(cmd string) (err error) {
	defer func() {
		if err != nil {
			_ = a.close()
		}
	}()
	cloud := !a.demo && a.cfg.Containers.Runtime == "boat"
	if cloud {
		if !statefs.Active(a.cfg.DataDirOr()) {
			a.stateLock, err = statelock.Acquire(a.cfg.DataDirOr())
			if err != nil {
				return err
			}
		}
		a.vault, a.keep, err = openCloudSecretStores(a.cfg.DataDirOr())
		if err != nil {
			return fmt.Errorf("cloud gateway secret stores are unavailable: %w", err)
		}
	}
	var opts []orchestrator.Option
	if a.demo || a.vmDemo {
		reg := provider.NewRegistry()
		reg.Add("demo", demo.NewBrain(), provider.Options{Kind: "demo", Model: "scripted"})
		for name := range a.cfg.Providers {
			reg.Add(name, demo.NewBrain(), provider.Options{Kind: "demo", Model: "scripted"})
		}
		opts = append(opts, orchestrator.WithProviders(reg))
		if a.cfg.DefaultProvider == "" {
			a.cfg.DefaultProvider = "demo"
		}
	}
	if a.demo {
		opts = append(opts, orchestrator.WithContainers(demo.NewDesktop(), nil))
		a.cfg.DataDir = filepath.Join(a.cfg.DataDirOr(), "demo")
		fmt.Fprintln(a.err, "kitties: demo mode, a scripted brain and a drawn desktop; nothing here is real")
	} else if cmd != "providers" && a.cfg.Containers.Runtime == "boat" {
		remote, err := boat.New(boat.Options{
			StateDir: filepath.Join(a.cfg.DataDirOr(), "boat"),
			APIKey:   os.Getenv(a.cfg.Boat.APIKeyEnv), Size: a.cfg.Boat.Size,
			TTL: time.Duration(a.cfg.Boat.TTLMinutes) * time.Minute, MaxRunning: a.cfg.Boat.MaxRunning,
		})
		if err != nil {
			return fmt.Errorf("Boat runtime: %w", err)
		}
		a.closeRuntime = remote.Close
		checkCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		accessErr := remote.Initialize(checkCtx)
		cancel()
		if accessErr != nil {
			return fmt.Errorf("Boat account readiness: %w", accessErr)
		}
		a.cfg.Containers.AutoUpdate = false
		opts = append(opts, orchestrator.WithContainers(remote, nil))
	} else if cmd != "providers" && a.cfg.Containers.Runtime == "lima" {
		if err := lima.Detect(context.Background()); err != nil {
			return err
		}
		a.cfg.Containers.AutoUpdate = false
		opts = append(opts, orchestrator.WithContainers(lima.New(filepath.Join(a.cfg.DataDirOr(), "lima")), nil))
		if a.vmDemo {
			fmt.Fprintln(a.err, "kitties: VM demo — the brain is scripted; the Linux computer and all desktop actions are real")
		}
	} else if cmd != "providers" {
		rt, err := detectRuntime(context.Background(), a.cfg.Containers.Runtime)
		if err != nil {
			fmt.Fprintf(a.err, "kitties: %v; the kitties run brain-only\n", err)
			opts = append(opts, orchestrator.WithContainers(nil, err), orchestrator.WithRuntimeRetry(func(ctx context.Context) (orchestrator.Containers, error) {
				rt, err := detectRuntime(ctx, a.cfg.Containers.Runtime)
				if err != nil {
					return nil, err
				}
				return newContainers(rt), nil
			}))
		} else {
			opts = append(opts, orchestrator.WithContainers(newContainers(rt), nil))
		}
	}
	fleet, err := orchestrator.New(a.cfg, opts...)
	if err != nil {
		return err
	}
	for _, p := range fleet.Settings().Providers {
		if p.Error != "" {
			fmt.Fprintf(a.err, "kitties: provider %q is not available: %s\n", p.Name, p.Error)
		}
	}
	chats, err := chat.New(fleet, filepath.Join(a.cfg.DataDirOr(), "chats"))
	if err != nil {
		return err
	}
	if u := os.Getenv("USER"); u != "" {
		chats.SetUser(u)
	}
	a.skills = skills.New(filepath.Join(a.cfg.DataDirOr(), "skills"))
	a.arts = artifacts.New(filepath.Join(a.cfg.DataDirOr(), "artifacts"))
	chats.SetLibrary(a.skills, a.arts)
	ag, err := agenda.Open(a.cfg.DataDirOr(), chats)
	if err != nil {
		return err
	}
	chats.SetAgenda(ag.Journal, ag)
	a.agenda = ag
	dataDir := a.cfg.DataDirOr()
	if a.approvals, err = approvals.Open(filepath.Join(dataDir, "approvals.json")); err != nil {
		return err
	}
	if a.budget, err = budget.Open(filepath.Join(dataDir, "budget.json")); err != nil {
		return err
	}
	a.memory = memory.Open(filepath.Join(dataDir, "memory"))
	// The saved secrets and the backups of the kitties' sessions need a key kept in the data
	// folder: where it cannot be written (a read-only volume) they are off, and the rest runs.
	if !cloud {
		a.vault, a.keep = openSecretStores(dataDir, a.err)
	}
	if a.vault != nil {
		chats.SetVault(a.vault)
		fleet.SetKeeper(a.keep)
	}
	chats.SetBudget(a.budget)
	chats.SetApprovals(a.approvals)
	chats.SetMemory(a.memory)
	g := a.cfg.Gateway
	a.notifier = notify.New(fleet.Connectors(), fleet.Notify, func() string {
		if g.PublicURL != "" {
			return g.PublicURL
		}
		return "http://" + g.Listen
	}, nil)
	chats.SetNotifier(a.notifier)
	a.digest = digest.New(digest.Source{
		Kitties: func() []digest.Kitty {
			var out []digest.Kitty
			for _, k := range fleet.List() {
				out = append(out, digest.Kitty{ID: k.ID, Name: k.Name})
			}
			return out
		},
		Journal: ag.Journal.Recent,
		Waiting: func() []string {
			var out []string
			for _, p := range a.approvals.List(approvals.Pending, 50) {
				out = append(out, p.KittyName+": "+p.Summary)
			}
			return out
		},
		Today:   a.budget.Today,
		Config:  fleet.Notify,
		Deliver: a.notifier.Deliver,
		Day:     digest.MyDay(fleet.Connectors()),
	}, filepath.Join(dataDir, "digest.json"))
	// A removed kitty takes its held actions and its memory along.
	ag.OnForget = append(ag.OnForget, a.approvals.Forget, a.memory.ForgetKitty, a.budget.Forget, chats.LeaveChats)
	if a.vault != nil {
		ag.OnForget = append(ag.OnForget, a.vault.ForgetKitty, a.keep.Forget)
	}
	// Chats whose kitties were removed earlier have nobody to answer: take those kitties out,
	// and drop the chats left empty.
	if err := chats.Prune(func(id string) bool { _, err := fleet.Get(id); return err == nil }); err != nil {
		fmt.Fprintf(a.err, "kitties: tidying the chats: %v\n", err)
	}
	a.fleet, a.chats = fleet, chats
	a.agenda.Scheduler.SetAdmission(fleet.Admission())
	a.digest.SetAdmission(fleet.Admission())
	fleet.OAuth().SetAdmission(fleet.Admission())
	fleet.Accounts().SetAdmission(fleet.Admission())
	a.updater = selfupdate.New(a.cfg.Updates, version)
	a.updater.Idle = func() bool { return !a.chats.AnyBusy() && !a.fleet.AnyHeld() && !a.fleet.Admission().Active() }
	a.backups, err = backup.New(backup.Options{DataDir: dataDir, WriteCapture: a.captureRecovery})
	return err
}

func (a *app) dispatch(cmd string, args []string) error {
	ctx, cancel := notifyContext()
	defer cancel()
	switch cmd {
	case "gateway":
		return a.cmdGateway(ctx, args)
	case "ls":
		return a.cmdList()
	case "providers":
		return a.cmdProviders()
	case "create":
		return a.cmdCreate(ctx, args)
	case "start", "stop", "rm":
		return a.cmdLifecycle(ctx, cmd, args)
	case "scale":
		return a.cmdScale(ctx, args)
	case "chat":
		return a.cmdChat(ctx, args)
	case "exec":
		return a.cmdExec(ctx, args)
	case "shot":
		return a.cmdShot(ctx, args)
	default:
		return fmt.Errorf("unknown command %q (run `kitties help`)", cmd)
	}
}

// demoConfig is the configuration of a demo without a file: one kitty of each kind.
func demoConfig() (config.Config, error) {
	cfg := config.Defaults()
	cfg.Providers = map[string]config.Provider{"demo": {Kind: "custom", Model: "scripted", BaseURL: "http://127.0.0.1:1"}}
	cfg.DefaultProvider = "demo"
	cfg.Kitties = []config.Kitty{
		{Name: "mimi", Soul: soul.Soul{Persona: "a patient researcher who loves to explain", Tone: "warm and precise", Traits: []string{"curious", "thorough"}, Skills: []string{"research", "summaries"}}},
		{Name: "tom", Soul: soul.Soul{Persona: "a hands-on engineer who tries things on the desktop before answering", Tone: "friendly and direct", Skills: []string{"browsing", "testing web apps"}}},
		{Name: "luna", Soul: soul.Soul{Persona: "a planner who keeps the team on track", Tone: "calm and structured", Skills: []string{"planning", "reviews"}}},
	}
	return cfg, cfg.Validate()
}

func cmdInit(path string, out, errOut io.Writer) int {
	if path == "" {
		path = "kitties.yaml"
	}
	if _, err := os.Stat(path); err == nil {
		fmt.Fprintf(errOut, "kitties: %s already exists, not touching it\n", path)
		return 1
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		fmt.Fprintf(errOut, "kitties: %v\n", err)
		return 1
	}
	if err := os.WriteFile(path, []byte(exampleConfig), 0o600); err != nil {
		fmt.Fprintf(errOut, "kitties: %v\n", err)
		return 1
	}
	soulPath := filepath.Join(filepath.Dir(path), "souls", "tom.yaml")
	_ = os.MkdirAll(filepath.Dir(soulPath), 0o700)
	if _, err := os.Stat(soulPath); err != nil {
		_ = os.WriteFile(soulPath, []byte(exampleSoul), 0o600)
	}
	fmt.Fprintf(out, "Wrote %s and %s.\nEdit the providers (keys come from OPENAI_API_KEY, ANTHROPIC_API_KEY...), then run: kitties gateway\n", path, soulPath)
	return 0
}

// gatewayToken is the token the gateway uses: the configured one, else the one a previous run
// left in the data directory (so a restart does not sign everybody out), else a new one. It is
// kept in the data directory where a program on this machine finds it.
func gatewayToken(cfg config.Config) (token, path string, fresh bool) {
	path = filepath.Join(cfg.DataDirOr(), "gateway.token")
	if cfg.Gateway.Token != "" {
		return cfg.Gateway.Token, path, false
	}
	if data, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(data)); len(t) >= 16 {
			return t, path, false
		}
	}
	return gateway.NewToken(), path, true
}

// cmdToken prints the token a gateway of this configuration uses, for signing in to the web page.
func cmdToken(cfg config.Config, out, errOut io.Writer) int {
	token, path, fresh := gatewayToken(cfg)
	if fresh {
		fmt.Fprintf(errOut, "kitties: no token yet (%s); start the gateway once and it makes one\n", path)
		return 1
	}
	fmt.Fprintln(out, token)
	return 0
}

func (a *app) cmdGateway(ctx context.Context, args []string) error {
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	launch := func(work func()) { workers.Add(1); go func() { defer workers.Done(); work() }() }
	fs := flag.NewFlagSet("gateway", flag.ContinueOnError)
	fs.SetOutput(a.err)
	listen := fs.String("listen", "", "address to listen on (default gateway.listen; 0.0.0.0:7488 serves the network)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *listen != "" {
		a.cfg.Gateway.Listen = *listen
		if err := a.cfg.Validate(); err != nil {
			return err
		}
	}
	token, tokenPath, _ := gatewayToken(a.cfg)
	if err := saveGatewayToken(tokenPath, token); err != nil {
		if a.cfg.Containers.Runtime == "boat" {
			return fmt.Errorf("cloud gateway cannot persist its sign-in token: %w", err)
		}
		fmt.Fprintf(a.err, "kitties: could not keep the token in %s: %v\n", tokenPath, err)
	} else {
		fmt.Fprintf(a.out, "gateway token saved in %s; use `kitties token` to display it\n", tokenPath)
	}
	if err := a.fleet.Bootstrap(ctx); err != nil {
		fmt.Fprintf(a.err, "kitties: some kitties did not start: %v\n", err)
	}
	if err := a.syncGoals(); err != nil {
		fmt.Fprintf(a.err, "kitties: goals from the configuration: %v\n", err)
	}
	for _, k := range a.fleet.List() {
		fmt.Fprintf(a.out, "  %-16s %-8s %s\n", k.Name, k.Status, k.Provider)
	}
	// A connection that signs in but has no account (one from the file, or a sign-in never
	// finished) would fail at its first use: it is said now.
	for _, c := range a.fleet.Settings().Connectors {
		if c.NeedsSignIn {
			fmt.Fprintf(a.err, "kitties: the connection %s (%s) has no account yet: sign in from Settings, Connections, or give it a key\n", c.Name, c.Label)
		}
	}
	g := a.cfg.Gateway
	srv := gateway.New(a.fleet, a.chats, token, version).WithLibrary(a.skills, a.arts).WithAgenda(a.agenda).
		WithAdmission(a.fleet.Admission()).WithBackups(a.backups).
		WithApprovals(a.chats).WithMemory(a.chats).WithMaintenance(a.fleet).WithUpdater(a.updater).WithNotifier(a.notifier).WithDigest(a.digest).
		WithPublicURL(g.PublicURL).WithProxy(g.TrustProxy).WithLocalToken(g.LocalTokenAllowed()).WithTLS(g.TLSCert, g.TLSKey)
	if a.vault != nil {
		srv.WithVault(a.vault)
	}
	if site, ok := webFS(); ok {
		srv.WithWeb(site)
	} else {
		fmt.Fprintln(a.err, "kitties: this build has no web interface inside (make web); serving the built-in page")
	}
	var logMu sync.Mutex
	logf := func(format string, args ...any) {
		logMu.Lock()
		defer logMu.Unlock()
		fmt.Fprintf(a.out, format+"\n", args...)
	}
	// The signed-in connectors keep their tokens fresh in the background; the scheduler wakes
	// the kitties up for their goals; the watchdog keeps their containers up.
	launch(func() { a.backups.Run(ctx) })
	launch(func() { a.fleet.KeepTokensFresh(ctx, logf) })
	a.agenda.Scheduler.SetLog(logf)
	a.notifier.SetLog(logf)
	launch(func() { a.agenda.Run(ctx) })
	launch(func() { a.digest.Run(ctx, logf) })
	launch(func() {
		a.fleet.Watch(ctx, watchEvery, func(k *kitty.Kitty, what string) {
			logf("watchdog: %s is back (%s)", k.Name, what)
			_ = a.agenda.Note(agenda.Entry{Kitty: k.ID, Kind: agenda.KindRecovered, Text: what})
			a.notifier.Notify(notify.Notification{Event: notify.Recovered, Kitty: k.Name, Title: "is back", Body: what})
		}, logf)
	})
	// A newer desktop image is downloaded and put on the idle desktops, their sessions kept.
	a.fleet.SetBusy(a.chats.KittyBusy)
	launch(func() {
		a.fleet.WatchUpdates(ctx, updateFirstCheck, time.Duration(a.cfg.Containers.UpdateCheckHours)*time.Hour, func(k *kitty.Kitty) {
			logf("update: the desktop of %s is on the newest image", k.Name)
			_ = a.agenda.Note(agenda.Entry{Kitty: k.ID, Kind: agenda.KindUpdated, Text: "its desktop was updated to the newest image; its sessions were kept"})
			a.notifier.Notify(notify.Notification{Event: notify.Updated, Kitty: k.Name, Title: "its desktop was updated", Body: "It runs the newest image now; its cookies, sessions and passwords were kept."})
		}, logf)
	})
	// Kitties itself: told about (notify) or moved to (auto) a newer release, inside the window and
	// when no kitty is working and no desktop is held.
	launch(func() { a.updater.Confirm(ctx) })
	if a.booted.RolledBack != "" {
		logf("update: %s did not hold and Kitties went back to %s; it will not be offered again", a.booted.RolledBack, version)
		a.notifier.Notify(rolledBackNote(a.booted.RolledBack, version))
	}
	window, _ := config.ParseWindow(a.cfg.Updates.Window)
	launch(func() {
		a.updater.Watch(ctx, updateFirstCheck, time.Duration(a.cfg.Updates.CheckHours)*time.Hour, updateHooks(a.notifier, func() bool { return window.Contains(time.Now()) }, logf))
	})
	return srv.Listen(ctx, g.Listen, logf)
}

// openSecretStores opens the vault of saved secrets and the store of session backups, which share
// a key kept in the data folder. Where the folder cannot be written they are both off (nil) and it
// says so: a read-only volume must not keep the gateway from starting.
func openSecretStores(dataDir string, warn io.Writer) (*vault.Store, *keep.Store) {
	v, err := vault.Open(dataDir)
	if err != nil {
		fmt.Fprintf(warn, "kitties: saved secrets and session backups are off: %v\n", err)
		return nil, nil
	}
	k, err := keep.Open(dataDir)
	if err != nil {
		fmt.Fprintf(warn, "kitties: saved secrets and session backups are off: %v\n", err)
		return nil, nil
	}
	return v, k
}

// rolledBackNote tells that a version that did not hold was gone back from.
func rolledBackNote(failed, now string) notify.Notification {
	return notify.Notification{Event: notify.Updated, Title: "Kitties went back to " + now,
		Body: failed + " did not start properly, so the previous version is running again. It will not be offered again."}
}

// updateHooks is what the updates of Kitties itself tell the person, and when they may run.
func updateHooks(n notify.Sender, window func() bool, logf func(string, ...any)) selfupdate.Hooks {
	return selfupdate.Hooks{
		Window: window,
		Available: func(st selfupdate.Status) {
			body := "Update it from Settings, Preferences."
			if st.Why != "" {
				body = st.Why
			}
			n.Notify(notify.Notification{Event: notify.Updated, Title: "Kitties " + st.Latest + " is available", Body: body})
		},
		Updated: func(from, to string) {
			n.Notify(notify.Notification{Event: notify.Updated, Title: "Kitties was updated to " + to, Body: "It was " + from + "; it restarts now, and the desktops of the kitties keep running."})
		},
		Log: logf,
	}
}

// updateFirstCheck is how long after the start the gateway first looks for a newer desktop image.
var updateFirstCheck = 2 * time.Minute

// watchEvery is how often the watchdog looks at the containers.
var watchEvery = 30 * time.Second

// syncGoals gives the agenda the goals the configuration lists, by the kitties' ids.
func (a *app) syncGoals() error {
	var goals []agenda.Goal
	for _, k := range a.cfg.Kitties {
		if len(k.Goals) == 0 {
			continue
		}
		names := []string{k.Name}
		if k.Replicas > 1 {
			names = names[:0]
			for i := 1; i <= k.Replicas; i++ {
				names = append(names, fmt.Sprintf("%s-%d", k.Name, i))
			}
		}
		for _, name := range names {
			kit, err := a.fleet.Get(name)
			if err != nil {
				continue
			}
			for _, g := range k.Goals {
				goals = append(goals, agenda.Goal{Kitty: kit.ID, Title: g.Title, Text: g.Text, Every: g.Every, On: g.On})
			}
		}
	}
	return a.agenda.Store.Sync(goals)
}

func (a *app) cmdList() error {
	list := a.fleet.List()
	if len(list) == 0 {
		fmt.Fprintln(a.out, "no kitties yet: `kitties create <name>` or list them in the configuration and run `kitties gateway`")
		return nil
	}
	fmt.Fprintf(a.out, "%-16s %-8s %-12s %-8s %-16s %s\n", "NAME", "STATUS", "PROVIDER", "DESKTOP", "AVATAR", "ID")
	for _, k := range list {
		desktop := "no"
		if k.Desktop {
			desktop = "yes"
		}
		fmt.Fprintf(a.out, "%-16s %-8s %-12s %-8s %-16s %s\n", k.Name, k.Status, k.Provider, desktop, k.Avatar.Breed+"/"+k.Avatar.Color, k.ID)
		if k.Error != "" {
			fmt.Fprintf(a.out, "  error: %s\n", k.Error)
		}
	}
	return nil
}

func (a *app) cmdProviders() error {
	fmt.Fprintln(a.out, "configured profiles:")
	for _, p := range a.fleet.Providers().List() {
		fmt.Fprintf(a.out, "  %-12s %s\n", p.Name, p.Describe)
	}
	fmt.Fprintln(a.out, "supported kinds:", strings.Join(provider.Kinds(), ", "))
	return nil
}

func (a *app) cmdCreate(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("create", flag.ContinueOnError)
	fs.SetOutput(a.err)
	prov := fs.String("provider", "", "provider profile (default: default_provider)")
	persona := fs.String("persona", "", "one line on who the kitty is")
	soulFile := fs.String("soul", "", "a soul YAML file")
	connectors := fs.String("connectors", "", "comma-separated connector names (default: every configured one)")
	noDesktop := fs.Bool("no-desktop", false, "no container, brain only")
	avatar := fs.String("avatar", "", "the pixel cat, as breed/color (tabby/orange); empty picks from the name")
	// The name may come first (kitties create ana -persona ...): flags are parsed after it.
	name := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		name, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if name == "" && fs.NArg() == 1 {
		name = fs.Arg(0)
	} else if fs.NArg() != 0 {
		name = ""
	}
	if name == "" {
		return errors.New("usage: kitties create <name> [-provider p] [-persona text] [-soul file] [-connectors a,b] [-no-desktop]")
	}
	spec := orchestrator.Spec{Name: name, Provider: *prov, SoulFile: *soulFile, Soul: soul.Soul{Persona: *persona}}
	if *connectors != "" {
		spec.Connectors = strings.Split(*connectors, ",")
	}
	if *noDesktop {
		no := false
		spec.Desktop = &no
	}
	if *avatar != "" {
		breed, color, _ := strings.Cut(*avatar, "/")
		spec.Avatar = kitty.Avatar{Breed: breed, Color: color}
	}
	k, err := a.fleet.Create(ctx, spec)
	if err != nil {
		return err
	}
	if err := a.fleet.Start(ctx, k.ID); err != nil {
		return fmt.Errorf("%s was created but did not start: %w", k.Name, err)
	}
	fmt.Fprintf(a.out, "%s is up (%s, id %s)\n", k.Name, k.Provider, k.ID)
	return nil
}

func (a *app) cmdLifecycle(ctx context.Context, cmd string, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: kitties %s <name>", cmd)
	}
	ops := map[string]func(context.Context, string) error{"start": a.fleet.Start, "stop": a.fleet.Stop, "rm": a.fleet.Remove}
	if err := ops[cmd](ctx, args[0]); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "%s: %s\n", args[0], cmd)
	return nil
}

func (a *app) cmdScale(ctx context.Context, args []string) error {
	if len(args) != 2 {
		return errors.New("usage: kitties scale <name> <replicas>")
	}
	n, err := strconv.Atoi(args[1])
	if err != nil {
		return fmt.Errorf("%q is not a number", args[1])
	}
	if err := a.fleet.Scale(ctx, args[0], n); err != nil {
		return err
	}
	return a.cmdList()
}

func (a *app) cmdExec(ctx context.Context, args []string) error {
	if len(args) < 2 {
		return errors.New("usage: kitties exec <name> <command...>")
	}
	out, err := a.fleet.Exec(ctx, args[0], args[1:]...)
	fmt.Fprint(a.out, out)
	return err
}

func (a *app) cmdShot(ctx context.Context, args []string) error {
	if len(args) != 2 {
		return errors.New("usage: kitties shot <name> <file.png>")
	}
	png, err := a.fleet.Screenshot(ctx, args[0])
	if err != nil {
		return err
	}
	if err := os.WriteFile(args[1], png, 0o600); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "saved %s (%d bytes)\n", args[1], len(png))
	return nil
}

// cmdChat is the terminal chat: one kitty, or a group of them.
func (a *app) cmdChat(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: kitties chat <name>[,<name>...]")
	}
	members := strings.Split(args[0], ",")
	sess, err := a.chats.Create("", members)
	if err != nil {
		return err
	}
	fmt.Fprintf(a.out, "chat %s with %s. Type a message; /quit ends it.\n", sess.ID, sess.Title)
	if sess.Group() {
		fmt.Fprintln(a.out, "(@name sends the message to one kitty; otherwise every kitty answers in turn)")
	}
	scanner := bufio.NewScanner(a.in)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for {
		fmt.Fprint(a.out, "> ")
		if !scanner.Scan() {
			fmt.Fprintln(a.out)
			return scanner.Err()
		}
		line := strings.TrimSpace(scanner.Text())
		switch line {
		case "":
			continue
		case "/quit", "/exit":
			return nil
		}
		turns, err := a.chats.Send(ctx, sess.ID, line)
		if err != nil {
			fmt.Fprintf(a.err, "kitties: %v\n", err)
			if ctx.Err() != nil {
				return nil
			}
			continue
		}
		working := false
		for _, t := range turns {
			fmt.Fprintf(a.out, "\n%s: %s\n", t.From, t.Text)
			for _, c := range t.Calls {
				if c.Err != "" {
					fmt.Fprintf(a.out, "  [%s failed: %s]\n", c.Name, c.Err)
				} else {
					fmt.Fprintf(a.out, "  [%s: done]\n", c.Name)
				}
			}
			working = working || t.Working
		}
		if working {
			a.followTask(ctx, sess.ID)
		}
		fmt.Fprintln(a.out)
	}
}

// followTask prints the steps of a desktop task as they happen, until the kitty is done.
func (a *app) followTask(ctx context.Context, id string) {
	fmt.Fprintln(a.out, "  (working on the desktop; ctrl+c cancels)")
	shown := map[int]int{}
	finished := map[int]bool{}
	for {
		select {
		case <-ctx.Done():
			a.chats.Cancel(id)
			a.chats.Wait()
			return
		case <-time.After(pollEvery):
		}
		sess, err := a.chats.Get(id)
		if err != nil {
			return
		}
		working := false
		for i, t := range sess.Turns {
			if t.From == "user" || finished[i] {
				continue
			}
			// The screenshot of a step lands just after the step does: while the task goes on, the
			// newest step waits until it has its shot or another step follows it.
			upto := len(t.Steps)
			if t.Working && upto > shown[i] && t.Steps[upto-1].Shot == "" {
				upto--
			}
			for _, st := range t.Steps[shown[i]:upto] {
				line := "  · " + st.Action
				if st.Error != "" {
					line += " failed: " + st.Error
				} else if st.Result != "" && st.Action != "done" {
					line += ": " + firstLine(st.Result)
				}
				if st.Shot != "" {
					line += "  [shot " + st.Shot + "]"
				}
				fmt.Fprintln(a.out, line)
			}
			shown[i] = upto
			if t.Working {
				working = true
				continue
			}
			// Finished: print the final words of a task once, then forget the turn.
			if shown[i] > 0 {
				if idx := strings.LastIndex(t.Text, "\n\n"); idx >= 0 {
					fmt.Fprintf(a.out, "\n%s: %s\n", t.From, t.Text[idx+2:])
				}
			}
			finished[i] = true
		}
		if !working {
			return
		}
	}
}

var pollEvery = 500 * time.Millisecond

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i] + "…"
	}
	if len(s) > 100 {
		s = s[:100] + "…"
	}
	return s
}
