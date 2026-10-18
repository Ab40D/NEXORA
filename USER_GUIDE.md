# SE7ENX: User Guide

This guide is for everyday users. No technical knowledge is needed, except for the parts marked
**"Ask your installer"**. Button names are written exactly as they appear on screen, in **bold**.

> **Good to know**
> * There is **no SE7ENX account** to create. Nothing to sign up for.
> * Until you connect a real light, everything happens in **Simulation**: a pretend lamp on your
>   screen. Simulation never switches anything in your home.
> * The app always shows which mode you are in.

---

## 1. What you need

* A phone, tablet or computer with a recent **Chrome** or **Edge** browser (other browsers may
  work but were not tested).
* For hand gestures: a **camera**.
* For voice: a **microphone** and a browser that supports speech recognition (Chrome, Edge or
  Safari; Firefox does not).
* For a real light: an installation prepared by your installer (see sections 6 and 7).

---

## 2. Try the lamp in simulation

1. Open the SE7ENX web address you were given.
2. You see a large lamp labelled **SIMULATION · OFF** with a violet "Simulated" badge.
3. Switch it on in any of these ways:
   * tap or click the lamp;
   * in the **Control** tab, press **Switch ON** (and **Switch OFF** to turn it off);
   * with a keyboard, press `Tab` until the **Tap to toggle** button on the lamp is highlighted,
     then press `Enter` or `Space` (with a real light connected, the button reads **Toggle light**).

---

## 3. Control the light with your hand

1. Open the **Gesture** tab and press **Enable camera**.
2. Your browser asks for permission to use the camera. Choose **Allow**.
   *The video is analysed on your device and is never uploaded or recorded. See section 9 for the
   one thing that is sent.*
3. You now see yourself with two lines: a **cyan line** (upper) and an **amber line** (lower).
4. **To switch ON:** show an **open hand** (all fingers spread, palm towards the camera) and hold it
   **above the cyan line** for about half a second.
5. **To switch OFF:** hold your open hand **below the amber line** for about half a second.
6. After each switch, move your hand out of that area before the next gesture.
7. If it does not react well, press **Calibrate** and follow the on-screen instructions: hold your
   hand low, then high.
8. To watch the tracking without switching anything, turn off **Send gesture commands**.
9. When finished, press **Turn camera off**.

Tips: use good lighting, keep your whole hand in the picture, and keep a little distance from the
camera. If the camera is unsure it sees a hand, it does nothing. That is on purpose.

---

## 4. Control the light with your voice

1. Open the **Voice** tab and press **Enable voice commands**.
2. Allow the microphone when your browser asks. SE7ENX itself records nothing.
3. Press **Listen** and say one of these phrases (or start **Hands-free 60 s** to talk without pressing
   the button for one minute):

   | | To switch ON | To switch OFF |
   | --- | --- | --- |
   | English | "Light on" · "Turn the light on" | "Light off" · "Turn the light off" |
   | Français | « Allume la lumière » · « Ouvre la lumière » | « Éteins la lumière » · « Ferme la lumière » |
   | العربية | «شغّل الضوء» · «شعّل الضو» | «أطفئ الضوء» · «طفّي الضو» |

4. Pick your language under **Recognition language**.
5. Press **Stop listening** to stop, or **Disable** to switch voice control off completely.

Only these short phrases work. Anything else, including "don't turn the light on", is ignored.
Voice can only switch the light on or off; it can never change settings.

*Privacy note:* most browsers send your voice to their own speech service (Google or Apple) to
understand it. Some Chrome versions can do it on your device instead: turn on
**Prefer on-device recognition (experimental)** and press **Download language pack**.

---

## 5. Stop hands-free control immediately

Press **Stop hands-free** at the top of the screen, or press the `Esc` key.

* All gesture and voice commands are blocked at once, and listening stops.
* The buttons in the **Control** tab still work.
* Press **Resume hands-free** to allow gestures and voice again.

This stop works **on this device only**. If other phones or computers are connected to the same
light, they are not stopped.

---

## 6. Connect a real light: SE7ENX Bridge

**Ask your installer** to set up the SE7ENX Bridge in your home network and give you:
the **Bridge URL**, a **pairing code**, the light's **group address**, and ideally its
**status group address**.

1. Press **Connect KNX** at the top of the screen. A setup window with 7 steps opens.
2. **Mode:** choose **Local KNX Bridge**, then **Next**.
3. **Backend:**
   * Type the **Bridge URL**, press **Check bridge**.
   * Type the **Pairing code** shown by the bridge, press **Pair**.
   * Press **Next**.
4. **Test link:** the app checks **Bridge reachable**, **Paired session valid**,
   **KNX interface connected** and **Bus confirmation**. No light is switched during this test.
   If something is red, read the hint, fix it, and press **Run again**.
5. **Address:** type the **Light group address (switching)**, for example `1/2/3`, and choose the
   **Datapoint type** your installer told you. Press **Next**.
6. **Feedback:** type the **Status / feedback group address (optional, recommended)**. Press
   **Read current state (GroupValueRead)** to see if the light answers. Then press
   **Activate live control**.
7. **Test:** you see the warning **"This operates real equipment"**.
   * Make sure it is safe to switch the light now, and ideally have someone watching it.
   * Tick **I understand that this switches real equipment and it is safe to do so now.**
   * Press **Send test ON**, then **Send test OFF**. Check that the real light follows.
   * You may press **Skip test** instead.
8. **Control:** live control is active. Press **Set up gestures** or **Set up voice**, or **Done**.

The app never switches the light on its own after connecting.

---

## 7. Connect a real light: Home Assistant (experimental)

> This option is new and has not yet been tested with a real Home Assistant. Use it only if you are
> comfortable with Home Assistant.

**Before you start (ask whoever manages your Home Assistant):** create a separate Home Assistant
user just for SE7ENX, **without administrator rights**. SE7ENX gets the same power as the account
you sign in with, so a limited account is safer.

1. Press **Connect KNX** → choose **Home Assistant** → **Next**.
2. Type the **Home Assistant URL** (it must start with `https://`).
3. Press **Sign in with Home Assistant**. You are taken to your Home Assistant's own login page.
   Log in there. SE7ENX never sees your password.
4. You come back to SE7ENX automatically. The **Test link** step checks your Home Assistant.
5. Continue exactly as in section 6, steps 5 to 8.

**Double-check the group address.** In this mode SE7ENX does not limit which addresses can be
switched, so a typing mistake could switch a different device.

---

## 8. Understand what the lamp tells you

| What you see | What it means |
| --- | --- |
| **SIMULATION** and a violet badge | Pretend lamp. Nothing in your home is switched |
| **ON** or **OFF** with "Device confirmed" | The light itself reported this state |
| A ring saying "requested" | Your command was sent; waiting for the light to report back |
| **ON · UNVERIFIED** (dim glow) | The command was sent, but the light cannot report its state (no status address) |
| **RECONNECTING** | The connection dropped; the app is trying again |
| **ERROR** | Something failed. The panel explains what to do |

The **History** tab (called **Log** on small screens) lists every command, where it came from
(button, gesture, voice, test) and whether it worked.

*Known issue:* right after a connection problem, "Device confirmed" may show an old state. If in
doubt, look at the light.

---

## 9. Disconnect and privacy

* **Disconnect** (in the **Control** tab) ends the connection to your light.
* Closing the browser tab also forgets the connection. Your settings stay saved in this browser.
* On a shared computer, always press **Disconnect** when you are done.

**What is sent where**

* Your **camera video never leaves your device**. However, the hand-tracking library made by Google
  sends **usage statistics** (no images) to Google about once a minute while the camera is on.
  These include the library version, how fast it runs, your IP address and browser type.
* Your **voice** usually goes to your browser's speech service (Google or Apple), unless on-device
  recognition is active.
* Light commands go only to **your** bridge or **your** Home Assistant.
* SE7ENX has no account database and stores nothing about you on its servers.

---

## 10. If something goes wrong

| Problem | Try this |
| --- | --- |
| The lamp says SIMULATION | You are not connected; press **Connect KNX** |
| "Cannot reach the SE7ENX Bridge" | Check the Bridge URL with your installer; your device must be on the home network (or the VPN your installer set up) |
| Chrome asks to allow "local network access" | Allow it if you trust the bridge address your installer gave you |
| "Pairing code is wrong or has expired" | Codes change every 15 minutes; ask for the newest code |
| The light does not react, the app shows an error | Read the hint in the panel; contact your installer with the error name |
| The camera does not start | Allow the camera in the browser's site settings; close other apps using the camera |
| My hand is not recognised | More light, whole hand visible, open palm; press **Calibrate** |
| Voice is not available | Your browser does not support it (e.g. Firefox); use gestures or buttons |
| Home Assistant sign-in fails | Start again from **Connect KNX**; your Home Assistant must use `https://` |

---

## 11. Words used in this guide

| Word | Meaning |
| --- | --- |
| **KNX** | The building system that controls lights, blinds and heating in many homes and offices |
| **Group address** | The "number" of a light in KNX, written like `1/2/3`. Your installer knows it |
| **Status (feedback) address** | A second number on which the light reports whether it is really on or off |
| **SE7ENX Bridge** | A small program in your home network that passes commands to KNX safely |
| **Pairing code** | A short code shown by the bridge that lets this device connect, like a TV pairing code (only before accounts are set up) |
| **Setup code** | The same console code, used once to create the owner account |
| **Reset code** | A one-time code (30 minutes) to choose a new password |
| **Guest** | Someone exploring the simulation without an account |
| **Simulation** | A pretend lamp for trying things out; never switches anything real |
| **Hands-free** | Gesture and voice control |

## 12. Accounts, roles and your building (SE7ENX hub)

When SE7ENX runs on your own hub (the Docker appliance), your building's data belongs to accounts on that hub.

**First start.** The page asks you to create the **owner** account. You need the **setup code** printed by the hub
(`docker compose logs se7enx`), your name, a username, and a password of **at least 15 characters**. A few unrelated
words are ideal, for example `violet tram sings at dawn`; no special characters are required. Tick **Keep me signed in**
only on your own devices.

**Signing in.** Use your username or e-mail. After a few wrong attempts SE7ENX makes you wait a little. The message
never says whether the username or the password was wrong; that keeps strangers from guessing accounts.

**Guests.** Choose **Explore as guest** to try the simulation. Guests cannot see or control anything in your building.
A small banner reminds you that you are a guest, and **Sign in** is always one click away.

**Roles.** Each account has one role. The hub checks every action, whatever the screen shows.

| Role | Typical use | Can |
| --- | --- | --- |
| Owner | The person responsible for the building | Everything; can never be locked out |
| Administrator | Trusted helper | Manage users below them, configure everything |
| Engineer | Installer / integrator | Building model, devices, integrations, automations |
| Technician | Maintenance | Operate devices, release the emergency stop, read the activity ledger |
| User | Family member, employee | View the building, control devices, use Talk to SE7ENX, engage the emergency stop |

**Adding people** (**Settings → Users and access**):

- **Create an account.** Leave the password empty and SE7ENX shows a **one-time code**. Give it to the person face to
  face. They choose **I have a reset code** on the sign-in page and pick their own password.
- **Invitations.** Create an invitation for a role and share the code. Self-registration is **off** by default; you
  can allow invitations only, or open registration.
- **Forgotten passwords.** Choose **Reset code** next to the person's name. If nobody can sign in, someone with access
  to the hub machine runs `docker compose exec se7enx se7enx-bridge reset-password <username>`.

**Your building** (**Building** tab):

- Start from a template (apartment, house, office) or create sites, buildings, floors and rooms yourself.
- Place each device in its room. Room names can be in your language.
- Deleting a floor or room never deletes devices; they only become "not placed".

**Activity.** The **Activity** tab lists who did what and through which interface: app, voice, gesture, Talk to
SE7ENX or the hub console. It also shows what really happened, for example *confirmed by the device*, *simulated* or
*refused*. Passwords and codes are never recorded.
