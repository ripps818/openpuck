#include "status_led.h"
#include "rf_link.h"
#include "bonds.h"
#include <Adafruit_TinyUSB.h>
#include <Arduino.h>

#if defined(OPK_BOARD_MDBT50Q_CX_40)
#include <nrf_gpio.h>

// The borrowed RX variant does not map the CX-40's active-low P0.08 LED.
#define WAKE_LED_PIN NRF_GPIO_PIN_MAP(0, 8)
#undef WAKE_LED_ON
#define WAKE_LED_ON LOW
#endif

#define PULSE_MS 500u

uint8_t g_ledMode = LED_MODE_STATUS;
uint8_t g_ledPinA = WAKE_LED_PIN_A;
uint8_t g_ledPinB = WAKE_LED_PIN_B;
uint8_t g_ledActiveLevel = (WAKE_LED_ON == HIGH) ? 1 : 0;

static unsigned long g_pulseMs = 0;
static bool g_lit = false;
static unsigned long g_testUntilMs = 0;
static int s_lastLevel = -1;

static void ledWrite(int level)
{
	int active = g_ledActiveLevel ? HIGH : LOW;
	int inactive = g_ledActiveLevel ? LOW : HIGH;
	int val = (level == HIGH) ? active : inactive;

#if defined(OPK_BOARD_MDBT50Q_CX_40)
	nrf_gpio_pin_write(WAKE_LED_PIN, val);
#else
	if (g_ledPinA != LED_PIN_NONE)
		digitalWrite(g_ledPinA, val);
	if (g_ledPinB != LED_PIN_NONE)
		digitalWrite(g_ledPinB, val);
#endif
}

static void ledSet(int level)
{
	if (level == s_lastLevel)
		return;
	s_lastLevel = level;
	ledWrite(level);
}

void ledApplyPins(uint8_t pinA, uint8_t pinB, uint8_t activeLevel)
{
	ledSet(LOW);

	g_ledPinA = pinA;
	g_ledPinB = pinB;
	g_ledActiveLevel = activeLevel ? 1 : 0;

#if !defined(OPK_BOARD_MDBT50Q_CX_40)
	if (g_ledPinA != LED_PIN_NONE)
		pinMode(g_ledPinA, OUTPUT);
	if (g_ledPinB != LED_PIN_NONE)
		pinMode(g_ledPinB, OUTPUT);
#endif

	s_lastLevel = -1;
	ledSet(LOW);
}

void ledInit()
{
#if defined(OPK_BOARD_MDBT50Q_CX_40)
	nrf_gpio_cfg_output(WAKE_LED_PIN);
#else
	if (g_ledPinA != LED_PIN_NONE)
		pinMode(g_ledPinA, OUTPUT);
	if (g_ledPinB != LED_PIN_NONE)
		pinMode(g_ledPinB, OUTPUT);
#endif
	s_lastLevel = -1;
	ledSet(LOW);
}

void ledWakePulse()
{
	g_pulseMs = millis();
	g_lit = true;

	// light immediately at the remoteWakeup() call site, not on the next loop
	ledSet(HIGH);
}

void ledTriggerTest(uint32_t ms)
{
	g_testUntilMs = millis() + ms;
	ledSet(HIGH);
}

void ledTask()
{
	if (g_testUntilMs != 0) {
		if (millis() < g_testUntilMs) {
			ledSet(HIGH);
			return;
		}
		g_testUntilMs = 0;
	}

	if (g_lit) {
		if (millis() - g_pulseMs >= PULSE_MS)
			g_lit = false;
		else {
			ledSet(HIGH);
			return;
		}
	}

	if (USBDevice.suspended()) {
		ledSet(LOW);
		return;
	}

	if (g_ledMode == LED_MODE_OFF) {
		ledSet(LOW);
		return;
	}

	if (g_ledMode == LED_MODE_ON) {
		ledSet(HIGH);
		return;
	}

	if (g_ledMode == LED_MODE_WAKE_ONLY) {
		ledSet(LOW);
		return;
	}

	if (g_ledMode == LED_MODE_HEARTBEAT) {
		unsigned long cycle = millis() % 1200u;
		bool beat = (cycle < 70u) || (cycle >= 180u && cycle < 250u);
		ledSet(beat ? HIGH : LOW);
		return;
	}

	if (anySlotLinkUp()) {
		ledSet(HIGH);
		return;
	}

	if (g_pairing || anySlotConnecting()) {
		bool on = (millis() % (LED_FAST_BLINK_MS * 2)) <
			  LED_FAST_BLINK_MS;
		ledSet(on ? HIGH : LOW);
		return;
	}

	bool on = (millis() % (LED_SLOW_BLINK_MS * 2)) < LED_SLOW_BLINK_MS;
	ledSet(on ? HIGH : LOW);
}
