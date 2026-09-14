// status_led.h -- LED status and wake indicator.
//
// Active state priorities (while host is awake):
//   1. Controller connected (anySlotLinkUp): solid ON (highest active priority;
//      immune to background RF ambient noise surveys or journal sweeps).
//   2. Controller scanning / connecting (g_pairing or anySlotConnecting):
//      fast blink at 5 Hz.
//   3. Idle / disconnected: slow blink at 1 Hz.
//
// Wake debugger behavior (while host is suspended):
// The LED is DARK in all steady states while wake is armed (host suspended), and flashes for
// half a second when a wake is actually sent (USBDevice.remoteWakeup()). It's a wake debugger: flash + PC
// stays asleep = resume signal was sent and the HOST ignored it (fix host-side: powercfg /deviceenablewake);
// no flash = firmware never fired (didn't see the gesture, or didn't consider the bus suspended).
//
// Board note: built with the Feather nRF52840 variant, but the usual hardware is a SuperMini "Pro Micro"
// clone. The Feather's user LED is P1.15 (D3, active high); the SuperMini's blue user LED is P0.15 (= D24 in
// the Feather pin map -- SPI MISO, unused here). We drive BOTH pins so the indicator works on either board.
// Override the pins/polarity below if your board differs.
#pragma once
#include <stdint.h>

#ifndef WAKE_LED_PIN_A

// Feather: P1.15 user LED (harmless unconnected pad on SuperMini clones)
#define WAKE_LED_PIN_A LED_BUILTIN
#endif
#ifndef WAKE_LED_PIN_B

// SuperMini "Pro Micro" clone: P0.15 blue user LED (D24 in the Feather map)
#define WAKE_LED_PIN_B 24
#endif
#ifndef WAKE_LED_ON

// Set LOW if your board's LED is wired active-low
#define WAKE_LED_ON HIGH
#endif

#define LED_PIN_NONE 0xFF

#define LED_MODE_STATUS 0
#define LED_MODE_HEARTBEAT 1
#define LED_MODE_WAKE_ONLY 2
#define LED_MODE_OFF 3
#define LED_MODE_ON 4
#define LED_MODE_MAX 4

#define LED_FAST_BLINK_MS 100u
#define LED_SLOW_BLINK_MS 500u

extern uint8_t g_ledMode;
extern uint8_t g_ledPinA;
extern uint8_t g_ledPinB;
extern uint8_t g_ledActiveLevel;

void ledInit(); // call once from setup(): pins to output, LED off

// call at each USBDevice.remoteWakeup() site: LED on now, off after 500ms
void ledWakePulse();
void ledTask(); // call every loop()
void ledApplyPins(uint8_t pinA, uint8_t pinB, uint8_t activeLevel);
void ledTriggerTest(uint32_t ms);

