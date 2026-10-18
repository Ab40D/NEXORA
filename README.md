# NEXORA — Local-First Building Intelligence

**Control your space. Connect your devices. Keep control local.**

NEXORA is a self-hosted building automation project exploring a more natural way to interact with physical spaces. It combines hand gestures, voice commands, a visual control interface, and real-device integrations to make building control more accessible.

The goal is to bring different devices and protocols into one interface without requiring a proprietary cloud platform.

> **Project status:** Experimental development project. Simulation is available for exploration, while physical-device integrations require local configuration and careful testing. Review the security and hardware-validation documentation before connecting real equipment.

[Support NEXORA on Ko-fi](https://ko-fi.com/se7enx) · [Report a bug](../../issues) · [Request a feature](../../issues)

---

## Contents

- [Overview](#overview)
- [Features](#features)
- [User interface](#user-interface)
- [Brightness and lighting control](#brightness-and-lighting-control)
- [Authentication and device pairing](#authentication-and-device-pairing)
- [Supported integrations](#supported-integrations)
- [Installation with Docker](#installation-with-docker)
- [Local development](#local-development)
- [Connecting real devices](#connecting-real-devices)
- [How it works](#how-it-works)
- [Privacy and security](#privacy-and-security)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Support the project](#support-the-project)
- [License](#license)

## Overview

Traditional building automation often requires separate applications, protocol-specific tools, or cloud-dependent services. NEXORA explores an alternative: a unified interface for interacting with connected spaces.

The current project focuses on a lighting-control experience that can be extended toward a broader building intelligence platform.

The long-term direction includes:

- Homes, offices, hotels, and other connected buildings.
- Local-first operation and self-hosted deployment.
- Protocol integrations for KNX, Home Assistant, Shelly, MQTT, and other compatible systems.
- Gesture-based and voice-based interaction.
- A unified interface for device states, commands, and automation.
- Future automation workflows and context-aware assistance.

NEXORA is under active development. The roadmap describes the intended direction; it should not be interpreted as a claim that every planned feature is already implemented.

## Features

### Multiple ways to control a device

**Manual controls**

Use the interface to inspect the current state and issue commands directly. Manual control remains available when gesture recognition or voice recognition is unavailable.

**Hand gestures**

The application uses MediaPipe-based hand tracking to interpret supported gestures.

The current interaction model uses hand position relative to configurable screen zones:

- Raise an open hand above the ON threshold to request activation.
- Move the hand below the OFF threshold to request deactivation.
- Hold a gesture long enough to satisfy the dwell threshold.
- Move away from the trigger zone to re-arm the interaction.

Smoothing, confidence thresholds, cooldowns, and calibration help reduce accidental commands.

Camera access is requested explicitly. Video frames are processed in the browser and are not uploaded by the application, although the MediaPipe library has its own telemetry behaviour described in the privacy section.

**Voice commands**

The voice interface uses the browser's Web Speech API where supported. Commands are restricted to an allowlist rather than interpreted as arbitrary instructions.

Examples include:

- `Light on`
- `Turn the light off`
- `Allume la lumière`
- `شغّل الضوء`
- `طفّي الضو`

Supported recognition languages and on-device processing depend on the browser and its installed speech services.

### Visual feedback

The 3D lighting interface provides a visual representation of the controlled light.

NEXORA distinguishes between simulated state, requested state, and confirmed device state. A command being accepted is not necessarily proof that the physical actuator has changed state.

Where the integration supplies suitable feedback, the interface can use reported device state to update the display. If the state cannot be verified, it should be presented as unverified rather than assumed to be correct.

### Simulation mode

Simulation allows users to explore the interaction experience without connecting physical equipment.

Simulation is separate from real-device operation. It must not be treated as evidence that a physical integration has been validated.

### Local device integration

The local appliance is designed to bring the interface and device connectivity into a self-hosted deployment. Depending on the configured integration, it can connect to Home Assistant, compatible Shelly devices, or a KNX installation.

### Safety-oriented interaction

The existing design includes explicit connection steps, a visible emergency-stop control, and safeguards around initial KNX commands. These controls reduce the risk of accidental switching, but they do not make the application a certified safety system.

## User interface

NEXORA is intended to provide one understandable interface for discovering, configuring, and controlling connected devices.

The current lighting experience includes:

- A 3D lamp with a visual state representation.
- Manual lighting controls.
- Gesture and voice interaction panels.
- A guided connection wizard.
- Connection and device-status feedback.
- A local appliance interface for configuring device integrations.
- Responsive layouts for desktop and mobile browsers.

The exact controls available depend on the integration and the current application build.

### Typical workflow

1. Open NEXORA in a supported browser.
2. Choose simulation or begin configuring a real integration.
3. Connect the required local service or device.
4. Complete the connection and pairing steps.
5. Verify the device and its reported state.
6. Test manual control before enabling gesture or voice commands.

Never assume that a successful connection test proves that every physical command or feedback path works correctly.

## Brightness and lighting control

Lighting control can involve more than a simple ON/OFF command. Dimmable actuators expose a brightness value that must be mapped to the appropriate device object and data-point type.

For KNX, the bridge supports a DPT 5.001 brightness value alongside DPT 1.001 switching. The configured ON level can be used where the applicable control path supports it.

Brightness behaviour depends on the actual actuator, its group-address configuration, and the controls exposed by the current interface.

Before using brightness control with physical equipment:

1. Confirm that the actuator supports dimming.
2. Identify the correct brightness communication object and group address.
3. Verify the configured data-point type.
4. Confirm that the value range and scaling match the device.
5. Test the command and verify the resulting state using suitable feedback.

**Current implementation note:** The available technical audit records DPT 5.001 support but lists a dedicated dimming slider as a limitation of the audited build. If a newer build adds a brightness slider or expanded dimming controls, update this section and the hardware test matrix to match the verified implementation.

Scenes, colour temperature, RGB control, and multi-device lighting workflows should be treated as separate capabilities and documented only when implemented and tested.

## Authentication and device pairing

NEXORA has different connection mechanisms depending on the deployment and integration.

### Local appliance pairing

The local appliance uses a pairing-code workflow to establish a connection with the local hub. Follow the code and URL printed by the running service.

In the audited implementation, pairing codes are single-use and rotate periodically. A restart may require pairing again because bridge sessions are stored in memory.

Do not expose pairing codes in public logs, screenshots, or support posts.

### Home Assistant sign-in

The Home Assistant integration uses Home Assistant's own authentication flow rather than asking users to provide their Home Assistant password directly to NEXORA.

The user signs in through the Home Assistant interface, and the application receives tokens needed for the connection. In the audited implementation, tokens are held in the browser tab's session storage, not in a NEXORA cloud database.

Use a dedicated Home Assistant account with the minimum permissions required. The audited implementation notes that Home Assistant tokens may inherit the full permissions of the account and do not provide application-level scopes.

### NEXORA user accounts

A local pairing code or Home Assistant sign-in is not the same as a separate NEXORA username-and-password account system. Do not assume that a dedicated NEXORA account service, multi-user role system, or cloud identity provider is included unless it is present in the current release.

## Supported integrations

| Integration | Purpose | Important notes |
|---|---|---|
| KNX | Building lighting and compatible actuator control | Requires correct group addresses, DPT mappings, gateway configuration, and suitable feedback |
| Home Assistant | Connect through an existing Home Assistant installation | Requires network reachability and the supported authentication flow |
| Shelly | Control compatible local Shelly devices | Verify the model, local network address, and supported device API |
| Simulation | Explore the interface without physical devices | Does not control hardware |

The local appliance documentation describes support for compatible Shelly Gen1 and Gen2+ devices, Home Assistant, and KNX configuration. Compatibility should be checked against the specific model and current release.

Other integrations, including MQTT, ESP32 devices, and additional automation platforms, are possible directions for future development; their presence in the roadmap does not guarantee that they are fully integrated today.

## Installation with Docker

Docker Compose is the recommended starting point for testing the local appliance. It packages the application and its local service components into a reproducible deployment.

### Requirements

- A Linux, macOS, or Windows host capable of running Docker.
- Docker Engine or Docker Desktop.
- Docker Compose v2.
- Network access to any physical devices or services you intend to connect.
- A supported browser for camera and microphone features.

### 1. Clone the repository

```bash
git clone https://github.com/Ab40D/NEXORA.git
cd NEXORA
```

If the repository is still published under another name, use the actual repository URL shown on GitHub.

### 2. Configure the appliance

```bash
cd deploy/appliance
cp .env.example .env
```

Open `.env` in your editor and configure only the values required by the deployment guide.

Do not publish your `.env` file. It may contain private network configuration, pairing settings, credentials, or certificate-related settings.

### 3. Start the appliance

```bash
docker compose up -d --build
```

Check the container status:

```bash
docker compose ps
```

Inspect startup logs and obtain the pairing information:

```bash
docker compose logs se7enx
```

### 4. Open the interface

Open the appliance address in your browser. The default port documented for the appliance is `8787`; use the protocol and address configured for your deployment.

For a service running on the same computer, the address may be:

```text
http://localhost:8787
```

If TLS is enabled, use the configured HTTPS URL and ensure that your browser trusts the certificate. For access from another device, use the host's reachable LAN address rather than `localhost`.

### 5. Connect a device

Open the device interface, select the required integration, enter its configuration, and complete the pairing or authentication steps.

Start with simulation or a non-critical test device. Verify connectivity and device feedback before enabling gesture or voice commands.

### Stop or restart

```bash
docker compose stop
docker compose start
```

To stop and remove the running Compose containers:

```bash
docker compose down
```

Persistent data and configuration may have separate storage requirements. Review the deployment guide before removing volumes or rebuilding an installation.

### Installation documentation

- `docs/LOCAL_DEPLOYMENT.md` — deployment, configuration, HTTPS, backup, and troubleshooting.
- `docs/HARDWARE_TEST_MATRIX.md` — hardware validation status.
- `DEPLOYMENT_CHECKLIST.md` — deployment checks and known risks.

## Local development

### Requirements

- Node.js 20.9 or newer.
- npm.
- Python 3.11 or newer for the bridge.
- Git.

### Install the web application

From the repository root:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

The simulation should be available without physical hardware.

The installation step also prepares the MediaPipe runtime assets required by the gesture interface.

### Run the bridge development stack

For the bridge development environment:

```bash
cd bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Return to the repository root before following the project's bridge-development instructions and test commands. The fake KNXnet/IP interface can be used to exercise protocol behaviour without writing to a physical KNX bus.

Consult `bridge/README.md` and the development tools in the repository for the exact bridge startup command and test configuration.

## Connecting real devices

### KNX

A KNX installation requires a compatible KNXnet/IP interface or router, a correctly configured bus, and valid group addresses.

The documented bridge configuration includes settings such as:

- KNX gateway address.
- Allowed group addresses.
- Switching and brightness DPT mappings.
- Optional status or feedback addresses.
- Allowed web application origins.
- Local bridge pairing configuration.

Use an allowlist for permitted group addresses. Do not expose a KNX gateway or the local bridge directly to the public internet.

For the first physical test, select a non-critical light, verify the connection, read the current state where supported, and send a deliberate test command only after reviewing the configured addresses.

### Home Assistant

Home Assistant must be reachable from the browser using the supported connection method. The KNX integration must already be configured if the goal is to control KNX devices through Home Assistant.

Use the documented sign-in flow and a dedicated account with appropriate permissions. Test state reporting and command behaviour against the actual Home Assistant version before relying on the integration.

### Shelly

For a compatible Shelly device, confirm its model and local IP address, then configure the supported integration in the appliance interface.

Keep the device on a trusted local network. Do not expose device credentials or unrestricted local-control endpoints in a public deployment.

## How it works

At a high level, NEXORA separates the user interface from the local integration layer.

```text
Browser interface
    ├── Manual commands
    ├── Hand-gesture recognition
    ├── Voice commands
    └── Visual device state
             |
             v
      Local application / bridge
             |
       ┌─────┼───────────┐
       v     v           v
      KNX  Home Assistant  Shelly
       |       |             |
       v       v             v
   Physical devices and reported state
```

The exact communication path depends on the selected integration. In a browser-hosted deployment, a local bridge or Home Assistant provides access to services that a public web frontend cannot directly reach on a private network.

The application should distinguish a requested command from a confirmed device state. A successful HTTP request, accepted command, or transport acknowledgement is not necessarily proof that the physical device changed state.

## Privacy and security

NEXORA is designed around local deployment, but local-first does not automatically mean that every dependency operates entirely offline.

### Camera

Camera access begins only after the user enables it. The application processes hand-tracking frames in the browser and does not upload or record those frames as part of its gesture workflow.

The audited MediaPipe Tasks Vision library sends usage telemetry to Google. The recorded audit describes telemetry containing SDK version, task type, latency statistics, IP address, browser user agent, and page origin. It does not include camera images, landmarks, or audio in that telemetry.

### Microphone

Microphone access is user-initiated through the voice interface. Depending on the browser and configuration, speech recognition may send audio to the browser vendor's speech service. On-device recognition availability varies.

### Credentials and storage

The audited implementation stores settings in browser local storage and connection tokens in session storage. It does not use a NEXORA server-side database for those browser sessions.

Protect local configuration files, pairing codes, Home Assistant tokens, KNX Secure keys, and certificates. Never commit real credentials or private keys to the public repository.

### Physical-device safety

Gesture and voice controls are convenience features, not safety-rated controls. Camera errors, speech recognition mistakes, network interruptions, stale feedback, or device faults can cause unexpected results.

Keep manual control available and use the emergency-stop functionality where provided. Do not use NEXORA as the sole control path for life-safety, security-critical, or hazardous equipment.

### Before exposing a service

- Do not forward the local bridge port directly to the internet.
- Use HTTPS where required by the deployment.
- Restrict allowed origins and KNX group addresses.
- Use dedicated accounts with minimum permissions.
- Verify certificate handling and token storage.
- Review `SECURITY_AUDIT.md` and `PRE_DEPLOYMENT_REVIEW.md`.
- Validate the actual hardware path before using the system operationally.

## Testing

The repository's documented test commands include:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For browser tests:

```bash
npx playwright install chromium
npm run test:e2e
```

For the Python bridge:

```bash
cd bridge
python -m pytest
ruff check .
```

The project has previously been tested with automated tests and a protocol-level fake KNXnet/IP interface. Such tests help validate application logic and protocol behaviour, but they do not replace testing against physical KNX interfaces, actuators, real Home Assistant installations, or every supported browser.

Consult `IMPLEMENTATION_REPORT.md`, `SECURITY_AUDIT.md`, and `docs/HARDWARE_TEST_MATRIX.md` for the validation status associated with the release.

## Known limitations

The following limitations were documented in the available technical audit and should be rechecked against newer code before a release:

- Physical KNX hardware validation was not completed for the audited build.
- The Home Assistant integration was tested against a mock rather than a full real installation.
- The audited UI supported DPT 1.001 switching and DPT 5.001 brightness mapping, but did not include a dedicated dimming slider.
- The main lighting workflow focused on one light per wizard session.
- Some KNX modes, including TCP tunnelling, KNX Secure, and routing, were implemented through the protocol library but were not fully validated on hardware.
- Bridge sessions were stored in memory, requiring pairing again after a restart.
- Gesture and speech behaviour varies by camera, lighting, microphone, browser, and recognition service.
- Some state-confirmation scenarios may require further validation, particularly after timeouts or reconnections.
- The audited emergency-stop behaviour applied to the current browser and did not provide a system-wide hardware kill switch.
- The documented authentication flow does not imply a complete NEXORA account and role-management system.

These limitations are part of the engineering status, not a guarantee that every later build has the same behaviour. Check the current source and release notes before relying on any feature.

## Roadmap

The long-term direction is to expand from a lighting-control experience into a broader building intelligence platform.

Potential development areas include:

- Improved brightness and multi-device lighting controls.
- More integrations for KNX, Shelly, Home Assistant, MQTT, and ESP32-based devices.
- Unified device discovery and capability mapping.
- Automation rules and reusable scenarios.
- More comprehensive state feedback and diagnostics.
- Better local authentication, permissions, and multi-user support.
- Expanded mobile and accessibility support.
- Local AI-assisted interaction and context-aware automation.
- Improved installation, upgrades, and hardware compatibility testing.

The roadmap is a plan, not a statement that these features are already available. Current implementation status should be tracked in `docs/ROADMAP.md` and the release changelog.

## Contributing

Contributions, bug reports, documentation improvements, and reproducible test cases are welcome.

Before opening a pull request:

1. Review the existing architecture and security documentation.
2. Keep secrets, local configuration, and private certificates out of commits.
3. Add tests for new behaviour where practical.
4. Document hardware requirements and validation status.
5. Avoid describing mocked or simulated behaviour as verified physical-device support.

For bugs or feature requests, open an issue through the repository's GitHub Issues page.

## Support the project

NEXORA is an independent development project focused on local-first building automation, accessible device control, and experimentation with connected spaces.

If you find the project useful or want to support continued development, you can contribute through Ko-fi:

**[Support NEXORA on Ko-fi](https://ko-fi.com/se7enx)**

Support helps fund development time, testing hardware, integration work, documentation, and future improvements. Donations are voluntary and do not purchase guaranteed features, support response times, or commercial service-level agreements.

## License

This project is intended to use the MIT License. See the repository's `LICENSE` file for the actual terms.

Third-party components remain subject to their respective licenses. Review the licenses and notices distributed with the relevant dependencies and model assets before redistribution.
