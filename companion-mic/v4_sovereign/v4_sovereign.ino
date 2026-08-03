/*
  WhiteBox companion mic — v4 "sovereign" (no Omi, no accounts, ours end-to-end)
  Board: Seeed XIAO nRF52840 Sense Plus, Seeeduino:nrf52 core (Bluefruit stack).

  Streams the on-board PDM microphone as raw 16 kHz mono 16-bit little-endian PCM
  over our OWN BLE GATT service. No third-party app, no cloud, no sign-in. The PC
  receiver (recv_ble.py) and any future WhiteBox-owned phone relay subscribe to
  the notify characteristic; each notification is [seq_lo, seq_hi, subindex] + PCM
  (a 3-byte header purely so the receiver can spot dropped packets).

    * Service UUID  b1a5c0de-0000-4f6c-9b21-7ea0f0dceafe  (advertised; receivers
                    recognize us by THIS 128-bit UUID alone)
    * Audio char    b1a5c0de-0001-...  READ|NOTIFY  — 16 kHz PCM16 LE frames
    * Codec char    b1a5c0de-0002-...  READ  — value 16 = "16 kHz PCM16 mono"

  Why 16 kHz now: we own both ends, so we are no longer pinned to the 8 kHz any
  stock app happened to assume. 16 kHz is whisper's native rate — cleaner text.

  Security: HOME path is the mic <-> this PC over short-range local RF (meters);
  AWAY path's real boundary is the Tailscale/WireGuard tunnel phone <-> home server.
  BLE link-layer bonding (LE Secure Connections) is a planned hardening step; it
  needs a one-time pairing confirmation, so it lands when a human is in the loop.
*/
#include <bluefruit.h>
#include <PDM.h>

// ---- WhiteBox UUIDs (ours; "b1a5c0de" = a fixed WhiteBox base, not Omi's) ----
#define WB_SVC "b1a5c0de-0000-4f6c-9b21-7ea0f0dceafe"
#define WB_AUD "b1a5c0de-0001-4f6c-9b21-7ea0f0dceafe"
#define WB_COD "b1a5c0de-0002-4f6c-9b21-7ea0f0dceafe"

#define PAYLOAD_SAMPLES 120                // 120 * 2 = 240 payload bytes (+3 hdr = 243, fits any MTU)
#define PKT_LEN (3 + PAYLOAD_SAMPLES * 2)

BLEService        audioSvc(WB_SVC);
BLECharacteristic audioChr(WB_AUD, BLERead | BLENotify, PKT_LEN);
BLECharacteristic codecChr(WB_COD, BLERead, 1, true);

static short        pdmBuf[512];
static volatile int pdmSamples = 0;

static uint8_t  pkt[PKT_LEN];
static int      outCount = 0;              // 16 kHz samples staged in the current packet
static uint16_t seq = 0;                   // running 16-bit packet counter

void onPDM() {
  int bytes = PDM.available();
  if (bytes > (int)sizeof(pdmBuf)) bytes = sizeof(pdmBuf);
  PDM.read(pdmBuf, bytes);
  pdmSamples = bytes / 2;
}

void connect_cb(uint16_t h) {
  Serial.print("[ble] connected, MTU=");
  Serial.println(Bluefruit.Connection(h)->getMtu());
}
void disconnect_cb(uint16_t h, uint8_t reason) {
  (void)h;
  Serial.print("[ble] disconnected, reason=0x");
  Serial.println(reason, HEX);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);         // LED active-LOW: HIGH = off

  // --- BLE peripheral ---
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);   // headroom for 16 kHz audio (~32 KB/s)
  Bluefruit.configUuid128Count(10);
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName("WhiteBox");
  Bluefruit.Periph.setConnectCallback(connect_cb);
  Bluefruit.Periph.setDisconnectCallback(disconnect_cb);
  Bluefruit.Periph.setConnInterval(6, 24);        // 7.5-30 ms

  audioSvc.begin();
  audioChr.begin();
  codecChr.begin();
  codecChr.write8(16);                            // 16 = 16 kHz PCM16 mono (our scheme)

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(audioSvc);     // 128-bit UUID in the AD payload
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);     // units of 0.625 ms
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);                 // 0 = advertise forever

  // --- PDM microphone ---
  PDM.onReceive(onPDM);
  PDM.setGain(50);
  if (!PDM.begin(1, 16000)) {                     // mono, 16 kHz (native, no downsample)
    Serial.println("[pdm] begin FAILED");
    while (1) { digitalWrite(LED_BUILTIN, LOW); delay(80); digitalWrite(LED_BUILTIN, HIGH); delay(80); }
  }
  Serial.println("[ok] advertising as 'WhiteBox' — svc b1a5c0de..., 16 kHz PCM16");
}

void loop() {
  // Not connected -> slow heartbeat blink, drop audio (keeps seq clean on connect)
  if (!Bluefruit.connected()) {
    pdmSamples = 0;
    outCount = 0;
    digitalWrite(LED_BUILTIN, (millis() % 1000 < 500) ? LOW : HIGH);
    return;
  }

  if (!pdmSamples) return;

  int n = pdmSamples;                             // snapshot the frame
  pdmSamples = 0;

  // LED lights on loud frames so you can see it hearing you
  int peak = 0;
  for (int i = 0; i < n; i++) { int a = pdmBuf[i]; if (a < 0) a = -a; if (a > peak) peak = a; }
  digitalWrite(LED_BUILTIN, peak > 300 ? LOW : HIGH);

  // 16 kHz PCM straight through (no downsample); notify when each packet fills
  for (int i = 0; i < n; i++) {
    int16_t s = pdmBuf[i];
    pkt[3 + outCount * 2]     = (uint8_t)(s & 0xFF);        // little-endian
    pkt[3 + outCount * 2 + 1] = (uint8_t)((s >> 8) & 0xFF);
    outCount++;
    if (outCount >= PAYLOAD_SAMPLES) {
      pkt[0] = (uint8_t)(seq & 0xFF);
      pkt[1] = (uint8_t)((seq >> 8) & 0xFF);
      pkt[2] = 0;                                  // sub-index (each notify is one chunk)
      audioChr.notify(pkt, PKT_LEN);               // no-op until the client enables CCCD
      seq++;
      outCount = 0;
    }
  }
}
