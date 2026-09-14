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

#define WAKE_LED_OFF ((WAKE_LED_ON) == HIGH ? LOW : HIGH)
#define PULSE_MS 500u // wake flash duration

static unsigned long g_pulseMs = 0;
static bool g_lit = false;
static int s_lastLevel = -1;

static void ledWrite(int level)
{
#if defined(OPK_BOARD_MDBT50Q_CX_40)
	nrf_gpio_pin_write(WAKE_LED_PIN, level);
#else
	digitalWrite(WAKE_LED_PIN_A, level);
	digitalWrite(WAKE_LED_PIN_B, level);
#endif
}

static void ledSet(int level)
{
	if (level == s_lastLevel)
		return;
	s_lastLevel = level;
	ledWrite(level);
}

void ledInit()
{
#if defined(OPK_BOARD_MDBT50Q_CX_40)
	nrf_gpio_cfg_output(WAKE_LED_PIN);
#else
	pinMode(WAKE_LED_PIN_A, OUTPUT);
	pinMode(WAKE_LED_PIN_B, OUTPUT);
#endif
	s_lastLevel = -1;
	ledSet(WAKE_LED_OFF);
}

void ledWakePulse()
{
	g_pulseMs = millis();
	g_lit = true;

	// light immediately at the remoteWakeup() call site, not on the next loop
	ledSet(WAKE_LED_ON);
}

void ledTask()
{
	if (g_lit) {
		if (millis() - g_pulseMs >= PULSE_MS)
			g_lit = false;
		else {
			ledSet(WAKE_LED_ON);
			return;
		}
	}

	if (USBDevice.suspended()) {
		ledSet(WAKE_LED_OFF);
		return;
	}

	if (anySlotLinkUp()) {
		ledSet(WAKE_LED_ON);
		return;
	}

	if (g_pairing || anySlotConnecting()) {
		bool on = (millis() % (LED_FAST_BLINK_MS * 2)) <
			  LED_FAST_BLINK_MS;
		ledSet(on ? WAKE_LED_ON : WAKE_LED_OFF);
		return;
	}

	bool on = (millis() % (LED_SLOW_BLINK_MS * 2)) < LED_SLOW_BLINK_MS;
	ledSet(on ? WAKE_LED_ON : WAKE_LED_OFF);
}
