package lima

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/madkoding/kitties/internal/container"
	"github.com/madkoding/kitties/internal/lima/guest"
)

var environmentKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func configuration(spec container.Spec) (string, error) {
	if !instanceName.MatchString(spec.Name) {
		return "", fmt.Errorf("invalid Kitties VM name %q", spec.Name)
	}
	if spec.MemoryMB < 0 || spec.CPUs < 0 || math.IsNaN(spec.CPUs) || math.IsInf(spec.CPUs, 0) {
		return "", errors.New("VM memory and CPUs must be finite, non-negative values")
	}
	if spec.Network != "" {
		return "", errors.New("Lima does not accept a Docker network name")
	}
	for key, value := range spec.Env {
		if !environmentKey.MatchString(key) || strings.ContainsRune(value, '\x00') {
			return "", fmt.Errorf("invalid guest environment variable %q", key)
		}
	}
	cpus := math.Ceil(spec.CPUs)
	if cpus == 0 {
		cpus = 2
	}
	memory := max(2048, spec.MemoryMB)
	var out strings.Builder
	fmt.Fprintf(&out, `minimumLimaVersion: "2.0.0"
base:
  - template:_images/debian-13
cpus: %.0f
memory: "%dMiB"
disk: "16GiB"
mounts: []
containerd:
  system: false
  user: false
ssh:
  forwardAgent: false
  loadDotSSHPubKeys: false
  forwardX11: false
  forwardX11Trusted: false
portForwards:
  - guestIP: "0.0.0.0"
    guestPortRange: [1, 65535]
    proto: any
    ignore: true
propagateProxyEnv: false
provision:
  - mode: system
    script: |
`, cpus, memory)
	for _, line := range strings.Split(strings.TrimSuffix(guest.Script, "\n"), "\n") {
		fmt.Fprintf(&out, "      %s\n", line)
	}
	return out.String(), nil
}

func guestEnvironment(name string, env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		if key != "DISPLAY" && key != "KITTY_NAME" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	values := make([]string, 0, len(keys)+2)
	for _, key := range keys {
		values = append(values, key+"="+env[key])
	}
	if _, ok := env["TZ"]; !ok {
		if tz := container.HostTimezone(); tz != "" {
			values = append(values, "TZ="+tz)
		}
	}
	return append(values, "DISPLAY=:99", "KITTY_NAME="+name)
}

func streamArguments(fps, quality int) ([]string, error) {
	if fps < 1 || fps > 30 || quality < 1 || quality > 100 {
		return nil, errors.New("stream fps must be 1–30 and JPEG quality 1–100")
	}
	return []string{"kitty-stream", "--stdin", strconv.Itoa(fps), strconv.Itoa(quality)}, nil
}
