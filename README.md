# FEI Thermo Web App

Chromium-only (uses Web Bluetooth). Runs on Chrome / Edge / Brave / Arc, desktop or Android. **Not** supported on Safari or iOS.

## Requirements

- HTTPS origin, OR `http://localhost`.
- Device advertising name must start with `FEI-Thermo-`.

## Local dev

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy (GitHub Pages, Netlify, Vercel, …)

Static files only — drop `web/` contents at the root of any HTTPS static host.

## Firmware update flow

1. Build firmware: `cd firmware && pio run`
2. Pack image:
   ```bash
   python3 tools/make_image.py \
     --in firmware/.pio/build/esp32s3/firmware.bin \
     --out dist/fei-thermo-1.1.0.s3th \
     --hw 1.0 --sw 1.1.0
   ```
3. Open web app → **Connect** → pick `FEI-Thermo-XXXX`.
4. Device info shows HW + FW from DIS (0x2A27 / 0x2A26).
5. Choose the `.s3th` file. App parses the 32-byte header, shows HW/SW and compatibility verdict.
6. If compatible, **Upload & Apply** streams the image over the OTA BLE service. Progress bar + status notifications update live. Device reboots on success.

## Compatibility rules (enforced by firmware AND web)

| Check | Behavior |
|---|---|
| `magic == "S3TH"` | required |
| `hw.major.minor == device HW` | required — no override |
| `image SW > device SW` | required, unless image header `flags.allow_downgrade` bit set |
| `CRC-32(payload) == header.image_crc32` | required |
| `size <= next OTA partition size` | required |

Device firmware never boots a committed OTA image without calling `esp_ota_mark_app_valid_cancel_rollback()` on first successful boot — safe rollback if the new build crashes.
