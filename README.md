# NEXORA — Local-First Building Intelligence

<p align="center">
  <img src="NEOXORA/kofi-character.png" alt="NEXORA mascot" width="150" />
</p>

<h3 align="center">Make your building respond to you.</h3>

<p align="center">
  A local-first platform exploring a more natural way to interact with smart buildings through visual controls, voice, hand gestures, and device integrations.
</p>

<p align="center">
  <a href="https://ko-fi.com/se7enx"><strong>Support the project on Ko-fi</strong></a>
  ·
  <a href="https://github.com/Ab40D/NEXORA/issues">Report a bug</a>
  ·
  <a href="https://github.com/Ab40D/NEXORA/issues">Suggest a feature</a>
</p>

---

## Overview

NEXORA is an experimental smart-building interaction platform designed to make building automation more accessible, intuitive, and adaptable.

The goal is to create a unified interface between people and their environments — connecting everyday interactions with the underlying systems that control lights and other building devices.

Rather than building another cloud-dependent smart-home dashboard, NEXORA explores a **local-first approach** with an architecture that can evolve to support different devices, protocols, and deployment environments.

**This project is actively under development.** The current version is a demonstration and testing platform, not a finished production building-management system.

## The Interface

<p align="center">
  <img src="NEOXORA/1.png" alt="NEXORA — current interface" width="100%" />
</p>

<p align="center"><em>The current NEXORA interface.</em></p>

## Inside NEXORA

<p align="center">
  <img src="NEOXORA/2.png" alt="NEXORA — internal interface and controls" width="100%" />
</p>

<p align="center"><em>A closer look at the experience and controls behind the interface.</em></p>

## Camera & Hand Gestures

<p align="center">
  <img src="NEOXORA/3.png" alt="NEXORA — camera-based hand gesture interaction" width="100%" />
</p>

<p align="center"><em>Exploring camera-based hand gestures as another way to interact with a room.</em></p>

## From the First Interface to NEXORA

<p align="center">
  <img src="NEOXORA/old-interface.png" alt="The earlier NEXORA interface" width="100%" />
</p>

<p align="center"><em>The earlier interface — a snapshot of how the project started.</em></p>

NEXORA is being developed iteratively. The interface, interaction methods, integrations, and deployment experience will continue to change as the project grows and feedback comes in.

## What NEXORA Is Exploring

- **Visual interaction:** Control interfaces designed around a clear, responsive experience.
- **3D interaction:** A visual environment for experimenting with lighting and device feedback.
- **Hand gestures:** Camera-based gesture recognition for hands-free interaction.
- **Voice interaction:** Browser-based speech capabilities, subject to browser and language support.
- **Building integrations:** An evolving integration layer for compatible Home Assistant entities, Shelly devices, and KNX installations.
- **Local deployment:** A path toward running the application and its local bridge in the user's own environment.
- **Extensible architecture:** A foundation for future protocols, automations, sensors, and interaction methods.

Availability depends on the selected integration and the current implementation. Not every feature has been validated with every physical device.

## How It Works

At a high level, NEXORA brings together three layers:

```text
┌─────────────────────────────────────┐
│          USER INTERACTION            │
│       UI · Voice · Hand Gestures     │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│        NEXORA INTERACTION LAYER      │
│   Controls · State · Device Requests │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│         DEVICE INTEGRATIONS          │
│       Home Assistant · Shelly · KNX  │
└─────────────────────────────────────┘
```

The long-term objective is to separate the way a user interacts with a building from the protocol used by its devices. This would make it easier to introduce new integrations without redesigning the entire user experience.

## Run NEXORA Locally

The local appliance is the intended starting point for testing. You will need Git and Docker with the Docker Compose plugin installed.

### 1. Clone the repository

```bash
git clone https://github.com/Ab40D/NEXORA.git
cd NEXORA
```

### 2. Configure the local appliance

```bash
cd deploy/appliance
cp .env.example .env
```

Review `.env` and configure the settings required for your environment. Do not publish access tokens, passwords, private keys, certificates, or your personal device addresses.

### 3. Build and start

```bash
docker compose up -d --build
docker compose ps
```

Check the service logs if anything fails to start:

```bash
docker compose logs --tail=100
```

### 4. Open the interface

Open the configured local appliance address in your browser. The default HTTP port is `8787`, but the protocol and URL may depend on the TLS configuration in your deployment.

For additional setup details, troubleshooting, and device configuration, see the deployment documentation in the repository.

> **Important:** Start with simulation or a safe test device. Do not connect NEXORA to critical building equipment until the relevant integration, permissions, and failure behaviour have been tested.

## Connecting Your Devices

NEXORA is intended to evolve beyond a single protocol.

| Integration | Purpose |
|---|---|
| Home Assistant | Work with compatible entities exposed by your Home Assistant setup. |
| Shelly | Explore local control of compatible Shelly devices. |
| KNX | Map supported KNX group addresses and datapoint types through the bridge. |
| Future integrations | Provide a place for contributors to develop and test additional protocols. |

Integration support varies by device, firmware, configuration, and current implementation. Consult the relevant documentation before testing with physical hardware.

## Development

The project contains a web application and a Python-based bridge. For development, install the dependencies required by each component and follow the repository's existing scripts and configuration.

Web application:

```bash
npm install
npm run dev
```

Bridge development:

```bash
cd bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

These commands are starting points; use the project's documentation and package scripts for the complete setup.

## Open to Contributions

**NEXORA is not meant to be limited to one developer's ideas.**

If you work with automation, embedded systems, software engineering, networking, interaction design, or documentation, contributions are welcome. You do not need to build an entire integration to help.

Ideas for contributions include:

- Adding or improving integrations for building-automation protocols.
- Developing support for sensors, switches, dimmers, and other device types.
- Improving the UI, accessibility, responsiveness, and user experience.
- Extending gesture recognition and voice interaction.
- Improving Docker deployment and local installation.
- Writing tests, reproducing bugs, and improving reliability.
- Reviewing the architecture and proposing better approaches.
- Translating documentation and helping make the project accessible to more users.

### How to contribute

1. Explore the repository and its existing documentation.
2. Check the [open issues](https://github.com/Ab40D/NEXORA/issues), or open an issue to discuss a new idea.
3. Fork the repository and create a branch for your changes.
4. Keep changes focused and include tests or reproduction steps when relevant.
5. Submit a pull request explaining what changed, why it matters, and how it was tested.

For significant architectural changes or new integrations, opening an issue first helps avoid duplicated work.

All contributors are expected to communicate respectfully, document limitations honestly, and avoid exposing credentials or private infrastructure details.

## Current Status

NEXORA is a work in progress. The current priority is to improve the local testing experience, refine the interface, strengthen integrations, and make it easier for other developers to run and extend the project.

Not every integration has been validated against physical hardware. Treat the project as experimental until the relevant functionality has been verified in your own environment.

## Privacy & Security

Local deployment can reduce reliance on external services, but it does not automatically make every component fully offline.

Camera-based processing, browser speech recognition, authentication flows, integrations, and telemetry may have different privacy characteristics. Review the relevant implementation and service settings before using NEXORA in a sensitive environment.

Never expose the appliance directly to the public internet without an appropriate security review. Use least-privilege credentials and restrict device access to the resources required for testing.

## Roadmap

The direction of development includes:

- Improving the local-first installation and onboarding experience.
- Expanding device and protocol integrations.
- Making device state and command feedback more reliable.
- Developing richer interactions between people and buildings.
- Improving tests, documentation, and contribution workflows.
- Exploring a unified interaction layer for residential and professional environments.

The roadmap will evolve with implementation progress, testing, and community feedback.

## Support the Project

NEXORA is an independent project built through experimentation, learning, and iteration.

If you find the idea useful or want to support continued development, you can contribute code, report issues, share feedback, or support the project financially.

<p align="center">
  <a href="https://ko-fi.com/se7enx">
    <strong>☕ Support NEXORA on Ko-fi</strong>
  </a>
</p>

<p align="center">
  Built by <a href="https://github.com/Ab40D">Abdelkhalek Mammeri</a>
</p>

<p align="center"><em>Building a more natural interface between people and the spaces around them.</em></p>
