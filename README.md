# findmygeo

Your photos. Their pins. The party game where your camera roll is the map: upload a few shots, then everyone races to pin them. Played off a TV and everyone's phones.

No accounts, no backend. The TV holds the game and phones connect straight to it over WebRTC.

## How to play

1. Open the site on the TV or laptop, pick the number of teams (2–8), photos per team (1–10) and a guess timer (30s, 60s, 90s, or a custom time). Teams get random animal names, which you can edit or shuffle. Open the room.
2. Players scan the QR code on screen (or open `?join=CODE`), type a name and pick a team.
3. Each player uploads photos. Every team has to upload the same number.
4. Each round, one photo goes up on the TV. The team that took it sits out. Every other team drops a pin on the map from their phone and locks it in.
5. Reveal: the real spot appears, with dashed lines from each pin and the distance in km.
6. Missing a pin costs 20,000 km. Lowest total after all rounds wins.

## Photos & GPS

Most phones store the location in the photo. Some browsers strip it before the site ever sees the file:

- **iPhone (Safari):** the photo picker often removes location. Tap **Options** in the picker and turn on **Location** if it shows up, or choose **Browse** / Files instead.
- **Android 13+:** pick from **Files** rather than the gallery app.
- **Anything else:** no location means you just tap the map where the photo was taken. That works fine.

## Troubleshooting

- **"Room not found"**: check the code on the TV. Codes are four letters and the room has to be open on the host screen.
- **Phones can't connect**: venue Wi-Fi often blocks the peer-to-peer traffic this relies on. Put everyone on phone data, or on a phone hotspot, and try again.
- **TV refreshed or crashed**: reload the page. The game picks up where it left off, photos included.

## Local dev

```sh
python3 -m http.server
```

Then open `http://localhost:8000/` for the host and `http://localhost:8000/?join=CODE` for a player.

To run without the public signaling server, start one locally:

```sh
npx peer --port 9000 --host 127.0.0.1
```

and append `&peerHost=localhost&peerPort=9000&peerPath=/&peerSecure=0` to both URLs (use `?` instead of `&` if there's no other query string).

## Tests

```sh
node --test test/*.test.mjs
```

## Credits

[Leaflet](https://leafletjs.com), [PeerJS](https://peerjs.com), [exifr](https://github.com/MikeKovarik/exifr), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). Map tiles © [Esri](https://www.esri.com) (World Gray Canvas), data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and others.
