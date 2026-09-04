#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <WebServer.h>

LiquidCrystal_I2C lcd(0x27, 20, 4);

#define RED_LED 32
#define YELLOW_LED 33
#define GREEN_LED 4

const char* WIFI_SSID = "Anshi";
const char* WIFI_PASSWORD = "Anshi1409";

WebServer server(80);

bool ambulanceApproaching = false;
float ambulanceDistanceM = 99999.0;
unsigned long ambulanceETASec = 0;

enum SignalState { RED_STATE, YELLOW_STATE, GREEN_STATE };
SignalState signalState = RED_STATE;

unsigned long approachStart = 0;
unsigned long yellowStart = 0;

const float APPROACH_DISTANCE_M = 750.0;
const unsigned long RED_TO_YELLOW_MS = 20000UL;
const unsigned long YELLOW_TO_GREEN_MS = 15000UL;

void setRed() {
  digitalWrite(RED_LED, HIGH);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(GREEN_LED, LOW);
  signalState = RED_STATE;
}

void setYellow() {
  digitalWrite(RED_LED, LOW);
  digitalWrite(YELLOW_LED, HIGH);
  digitalWrite(GREEN_LED, LOW);
  signalState = YELLOW_STATE;
}

void setGreen() {
  digitalWrite(RED_LED, LOW);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(GREEN_LED, HIGH);
  signalState = GREEN_STATE;
}

String etaText() {
  unsigned long m = ambulanceETASec / 60;
  unsigned long s = ambulanceETASec % 60;
  char buf[16];
  if (m > 0) {
    snprintf(buf, sizeof(buf), "%lum %02lus", m, s);
  } else {
    snprintf(buf, sizeof(buf), "%lus", s);
  }
  return String(buf);
}

void showApproachLCD() {
  lcd.backlight();
  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print("AMBULANCE APPROACH");

  lcd.setCursor(0, 1);
  lcd.print("DIST: ");
  if (ambulanceDistanceM >= 1000) {
    lcd.print(ambulanceDistanceM / 1000.0, 1);
    lcd.print(" km");
  } else {
    lcd.print((int)ambulanceDistanceM);
    lcd.print(" m");
  }

  lcd.setCursor(0, 2);
  lcd.print("ETA: ");
  lcd.print(etaText());

  lcd.setCursor(0, 3);
  if (signalState == RED_STATE) lcd.print("PLEASE GIVE WAY");
  else if (signalState == YELLOW_STATE) lcd.print("GET READY...");
  else lcd.print("GREEN FOR AMBULANCE");
}

void resetSystem() {
  ambulanceApproaching = false;
  ambulanceDistanceM = 99999.0;
  ambulanceETASec = 0;
  approachStart = 0;
  yellowStart = 0;
  setRed();
  lcd.clear();
  lcd.noBacklight();
}

void cors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
}

void handleTrafficUpdate() {
  cors();

  if (!server.hasArg("distance")) {
    server.send(400, "application/json", "{\"error\":\"distance required\"}");
    return;
  }

  ambulanceDistanceM = server.arg("distance").toFloat();
  if (server.hasArg("eta")) ambulanceETASec = server.arg("eta").toInt();

  if (ambulanceDistanceM > APPROACH_DISTANCE_M) {
    resetSystem();
    server.send(200, "application/json", "{\"status\":\"outside_zone\"}");
    return;
  }

  if (!ambulanceApproaching) {
    ambulanceApproaching = true;
    approachStart = millis();
    setRed();
  }

  showApproachLCD();

  server.send(200, "application/json", "{\"status\":\"approaching\"}");
}

void handleStatus() {
  cors();

  String state = "normal";
  if (ambulanceApproaching && signalState == RED_STATE) state = "red_approaching";
  else if (signalState == YELLOW_STATE) state = "yellow";
  else if (signalState == GREEN_STATE) state = "green";

  String json = "{\"state\":\"" + state +
                "\",\"distance\":" + String(ambulanceDistanceM, 1) +
                ",\"eta\":" + String(ambulanceETASec) + "}";
  server.send(200, "application/json", json);
}

void handleEmergencyOn() {
  cors();
  ambulanceApproaching = true;
  approachStart = millis();
  setRed();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("AMBULANCE IS COMING");
  lcd.setCursor(0, 1); lcd.print("GIVE WAY");
  lcd.setCursor(0, 2); lcd.print("GREEN FOR AMBULANCE");
  lcd.setCursor(0, 3); lcd.print("PLEASE CLEAR ROAD");
  server.send(200, "application/json", "{\"status\":\"on\"}");
}

void handleEmergencyOff() {
  cors();
  resetSystem();
  server.send(200, "application/json", "{\"status\":\"off\"}");
}

void setup() {
  Serial.begin(115200);

  Wire.begin(21, 22);
  lcd.init();
  lcd.noBacklight();

  pinMode(RED_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  setRed();

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());

  server.on("/traffic/update", HTTP_GET, handleTrafficUpdate);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/emergency/on", HTTP_GET, handleEmergencyOn);
  server.on("/emergency/off", HTTP_GET, handleEmergencyOff);

  server.begin();
  Serial.println("Traffic signal controller ready.");
}

void loop() {
  server.handleClient();

  if (!ambulanceApproaching) return;

  unsigned long now = millis();

  if (signalState == RED_STATE &&
      now - approachStart >= RED_TO_YELLOW_MS) {
    setYellow();
    yellowStart = now;
    showApproachLCD();
  }

  if (signalState == YELLOW_STATE &&
      now - yellowStart >= YELLOW_TO_GREEN_MS) {
    setGreen();
    showApproachLCD();
  }
}
