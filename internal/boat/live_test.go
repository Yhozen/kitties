package boat

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madkoding/kitties/internal/container"
)

// This canary creates one paid VM at a time and leaves its final machine stopped
// with a permanent recovery checkpoint. State must live outside a test tempdir.
func TestLiveBoatDesktopRecovery(t *testing.T) {
	if os.Getenv("KITTIES_BOAT_LIVE") != "1" {
		t.Skip("set KITTIES_BOAT_LIVE=1 for the paid provider canary")
	}
	state := os.Getenv("KITTIES_BOAT_LIVE_STATE")
	if state == "" {
		t.Fatal("KITTIES_BOAT_LIVE_STATE must be a persistent absolute directory")
	}
	m, err := New(Options{StateDir: state, APIKey: os.Getenv("BOAT_DEV_API_KEY"), MaxRunning: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	if err = m.CheckAccess(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if r, err := m.lookup("kitty-cloud-canary"); err == nil && !r.Removed && (r.Pending == nil || r.Pending.Kind != "delete") {
			if err = m.Stop(cleanup, "kitty-cloud-canary"); err != nil {
				t.Logf("CANARY CLEANUP NEEDS ATTENTION: %v", err)
			}
		}
	})
	if r, err := m.lookup("kitty-cloud-canary"); err == nil && r.Pending != nil && r.Pending.Kind == "delete" {
		if err = m.Remove(ctx, r.Name); err != nil {
			t.Fatal(err)
		}
	}
	var id string
	if r, lookupErr := m.lookup("kitty-cloud-canary"); lookupErr == nil {
		err = m.Start(ctx, r.Name)
		current, _ := m.Resolve(ctx, r.Name)
		id = current.ID
	} else {
		id, err = m.Up(ctx, container.Spec{Name: "kitty-cloud-canary", KittyName: "cloud-canary"})
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Log("desktop started", id)
	run := func(argv ...string) string {
		t.Helper()
		out, err := m.Exec(ctx, "kitty-cloud-canary", argv...)
		if err != nil {
			t.Fatalf("guest %s: %v", argv[0], err)
		}
		return out
	}
	if got := strings.TrimSpace(run("id", "-un")); got != "kitty" {
		t.Fatalf("ordinary command user = %q", got)
	}
	run("sh", "-c", `test -z "${BOAT_DEV_API_KEY:-}" && test -z "${OPENAI_API_KEY:-}"`)
	marker := "boat-canary-" + randomID()
	run("sh", "-c", `printf '%s' "$1" > /home/kitty/work/durable-marker`, "sh", marker)
	run("sudo", "-n", "apt-get", "-o", "DPkg::Lock::Timeout=300", "install", "-y", "-qq", "moreutils")
	run("kitty-clip", "set", marker)
	if got := run("kitty-clip", "get"); got != marker {
		t.Fatalf("clipboard got %q", got)
	}
	run("xdotool", "mousemove", "120", "140", "click", "1", "key", "Escape")
	shot, err := m.Screenshot(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = png.Decode(bytes.NewReader(shot)); err != nil {
		t.Fatalf("screenshot is not PNG: %v", err)
	}
	if err = os.WriteFile(m.dir+"/desktop.png", shot, 0o600); err != nil {
		t.Fatal(err)
	}
	stream, err := m.Stream(ctx, id, 8, 70)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(stream)
	header, err := reader.ReadString('\n')
	if err != nil {
		stream.Close()
		t.Fatal(err)
	}
	var length int
	if _, err = fmt.Sscanf(header, "FRAME %d\n", &length); err != nil || length < 1 {
		stream.Close()
		t.Fatalf("stream header %q", header)
	}
	if _, err = io.CopyN(io.Discard, reader, int64(length)); err != nil {
		stream.Close()
		t.Fatal(err)
	}
	if err = stream.Close(); err != nil {
		t.Fatal(err)
	}
	run("sh", "-c", `for i in 1 2 3 4 5; do pgrep -u kitty -x kitty-grab >/dev/null || exit 0; sleep 1; done; exit 1`)
	run("kitty-open", "https://example.com")
	// A persistent browser cookie represents login state without using a real account.
	script := `import json,urllib.request,websocket,time
for attempt in range(30):
 try:
  info=json.load(urllib.request.urlopen('http://127.0.0.1:19222/json/version', timeout=2))
  break
 except OSError:
  if attempt == 29: raise
  time.sleep(1)
w=websocket.create_connection(info['webSocketDebuggerUrl'],suppress_origin=True,timeout=15)
w.send(json.dumps({'id':1,'method':'Storage.setCookies','params':{'cookies':[{'name':'kitties_canary','value':'` + marker + `','domain':'example.com','path':'/','expires':4102444800}]}}))
while True:
 r=json.loads(w.recv())
 if r.get('id')==1:
  if 'error' in r: raise RuntimeError(r['error'])
  break
w.close()
`
	if _, err = m.ExecInput(ctx, id, script, "python3", "-"); err != nil {
		t.Fatal(err)
	}
	if err = m.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	t.Log("original machine deleted; restoring permanent checkpoint")
	if err = m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	ref, err := m.Resolve(ctx, id)
	if err != nil || ref.ID == id {
		t.Fatalf("did not restore a new machine: %+v %v", ref, err)
	}
	if got := run("cat", "/home/kitty/work/durable-marker"); got != marker {
		t.Fatalf("file did not survive restore: %q", got)
	}
	if got := strings.TrimSpace(run("dpkg-query", "-W", "-f=${Status}", "moreutils")); got != "install ok installed" {
		t.Fatalf("package did not persist: %q", got)
	}
	run("kitty-open", "https://example.com")
	cookieScript := `import json,urllib.request,websocket,time
for attempt in range(30):
 try:
  info=json.load(urllib.request.urlopen('http://127.0.0.1:19222/json/version', timeout=2))
  break
 except OSError:
  if attempt == 29: raise
  time.sleep(1)
w=websocket.create_connection(info['webSocketDebuggerUrl'],suppress_origin=True,timeout=15)
w.send(json.dumps({'id':1,'method':'Storage.getCookies'}))
while True:
 r=json.loads(w.recv())
 if r.get('id')==1:
  print(json.dumps(r.get('result',{}).get('cookies',[])))
  break
w.close()
`
	out, err := m.ExecInput(ctx, ref.ID, cookieScript, "python3", "-")
	if err != nil {
		t.Fatal(err)
	}
	var cookies []struct{ Name, Value string }
	if err = json.Unmarshal([]byte(out), &cookies); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, cookie := range cookies {
		if cookie.Name == "kitties_canary" && cookie.Value == marker {
			found = true
		}
	}
	if !found {
		t.Fatal("browser login cookie did not survive new-machine restore")
	}
	if err = m.Stop(ctx, ref.ID); err != nil {
		t.Fatal(err)
	}
	export, err := os.Create(m.dir + "/home.tar")
	if err != nil {
		t.Fatal(err)
	}
	if err = export.Chmod(0o600); err != nil {
		export.Close()
		t.Fatal(err)
	}
	if err = m.ExportHome(ctx, ref.ID, export); err != nil {
		export.Close()
		t.Fatal(err)
	}
	if _, err = export.Seek(0, 0); err != nil {
		export.Close()
		t.Fatal(err)
	}
	archive := tar.NewReader(export)
	foundMarker, foundCookies := false, false
	for {
		header, e := archive.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			export.Close()
			t.Fatal(e)
		}
		if strings.HasSuffix(header.Name, "work/durable-marker") {
			data, e := io.ReadAll(archive)
			if e != nil {
				t.Fatal(e)
			}
			foundMarker = string(data) == marker
		}
		if strings.HasSuffix(header.Name, "work/.browser/Default/Cookies") && header.Size > 0 {
			foundCookies = true
		}
	}
	export.Close()
	if !foundMarker || !foundCookies {
		t.Fatalf("home export incomplete: marker=%v cookies=%v", foundMarker, foundCookies)
	}
	t.Log("fresh-machine restore and independent home export verified; final computer stopped", ref.ID)
}
