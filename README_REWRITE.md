# Ambulance Alert System - GPS Filter + ESP32 Traffic Signal Update

## Main changes
- Removes raw GPS breadcrumb/trail drawing.
- Filters poor-accuracy GPS and small stationary GPS drift.
- Smoothly animates the ambulance marker between accepted positions.
- Uses OSRM driving distance/duration for route telemetry.
- Adds ESP32 controller URL field in Traffic Control Center.
- Sends road distance and ETA to ESP32 when ambulance is within 750 m.
- Includes `traffic_signal_esp32.ino` with LCD + RED/YELLOW/GREEN timing.

## Run
1. Extract the ZIP.
2. Open a terminal in the project folder.
3. Run `npm install` if dependencies are not already installed.
4. Run `npm start`.
5. Open the displayed URL.

## ESP32
Open `traffic_signal_esp32.ino` in Arduino IDE.
Replace `YOUR_WIFI_NAME` and `YOUR_WIFI_PASSWORD`.
Upload it to the ESP32 and note the IP shown in Serial Monitor.
In Traffic Control Center, enter that IP (for example `http://192.168.1.100`) and click Connect ESP32.

## Signal sequence
When the filtered OSRM road distance becomes <= 750 m:
- LCD turns on and shows ambulance approach, distance and ETA.
- RED remains for 20 seconds.
- YELLOW remains for 15 seconds.
- GREEN then turns on.

If the ambulance goes outside 750 m, the controller resets to RED and LCD OFF.

## Important
The ESP32 sketch enables permissive CORS so the website can call it directly over the local network.
