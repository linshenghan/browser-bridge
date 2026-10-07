package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"browser-bridge/internal/wire"
	"testing"
)

func TestScreenshotSegmentsPreserveMetadata(t *testing.T) {
	im := image.NewRGBA(image.Rect(0, 0, 3, 2))
	im.Set(1, 1, color.RGBA{1, 2, 3, 255})
	var b bytes.Buffer
	if err := png.Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	data := base64.StdEncoding.EncodeToString(b.Bytes())
	s := &Session{Output: t.TempDir()}
	raw, err := saveScreenshot(s, wire.Raw(map[string]any{"screenshotId": "shot-1", "pageVersion": "page-1", "images": []any{map[string]any{"data": data, "clip": map[string]int{"x": 0, "y": 0, "width": 3, "height": 2}}, map[string]any{"data": data}}, "truncated": true, "nextOffsetY": 2}))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out["screenshotId"] != "shot-1" || out["pageVersion"] != "page-1" || out["truncated"] != true {
		t.Fatal("metadata lost")
	}
	for _, v := range out["images"].([]any) {
		i := v.(map[string]any)
		if i["width"] != float64(3) || i["height"] != float64(2) {
			t.Fatal(i)
		}
		p := i["path"].(string)
		if _, err := os.Stat(p); err != nil {
			t.Fatal(err)
		}
	}
}
func TestScreenshotRejectsInvalidImage(t *testing.T) {
	_, err := saveScreenshot(&Session{Output: t.TempDir()}, wire.Raw(map[string]any{"images": []any{map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("not png"))}}}))
	if err == nil {
		t.Fatal("accepted invalid image")
	}
}
func TestV2CapabilityNegotiation(t *testing.T) {
	for _, m := range []string{"tab.claim", "tab.release", "page.find", "page.wait", "page.dialog", "download.expect"} {
		if requiredCapability(m, Input{}) == "" {
			t.Fatal(m)
		}
	}
	if requiredCapability("page.screenshot", Input{Mode: "fullpage"}) != "screenshots-v2" {
		t.Fatal("missing screenshot negotiation")
	}
	if requiredCapability("page.screenshot", Input{}) != "" {
		t.Fatal("legacy viewport broken")
	}
}
func TestReadinessRequiresActualCapabilitiesEvenWithMatchingVersion(t *testing.T) {
	ready, missing := extensionReadiness(wire.Raw(map[string]any{"extensionVersion": AppVersion}))
	if ready || len(missing) != len(expectedCapabilities) {
		t.Fatal("cached old worker reported healthy")
	}
	ready, missing = extensionReadiness(wire.Raw(map[string]any{"extensionVersion": AppVersion, "capabilities": expectedCapabilities}))
	if !ready || len(missing) != 0 {
		t.Fatal("current extension reported incompatible")
	}
	ready, _ = extensionReadiness(wire.Raw(map[string]any{"extensionVersion": "0.1.1", "capabilities": expectedCapabilities}))
	if ready {
		t.Fatal("different version reported healthy")
	}
}
func TestV2InputAndMutationRules(t *testing.T) {
	for _, m := range []string{"tab.claim", "tab.release", "page.dialog", "download.expect"} {
		if !isMutation(m) {
			t.Fatal(m)
		}
	}
	for _, c := range []struct {
		method string
		in     Input
	}{{"page.act", Input{Target: &Target{}, Element: "e1"}}, {"file.upload", Input{}}, {"download.status", Input{}}, {"page.screenshot", Input{Mode: "region", Region: &Region{Width: -1, Height: 20}}}, {"page.wait", Input{TimeoutSeconds: 100}}} {
		if validateInput(c.method, c.in) == nil {
			t.Fatal(c.method)
		}
	}
}
