# Reqmo Web (Vuetify3)

Dispatcher/admin UI built with Vue 3 + Vuetify 3 via CDN.
The UI reads backend data from `/api/*`.

## Run

```bash
cd packages/web
python -m http.server 5173
```

Open [http://localhost:5173](http://localhost:5173).

## Simulation Page

- Main dispatch UI: [http://localhost:5173](http://localhost:5173)
- Analytics UI: [http://localhost:5173/analytics/](http://localhost:5173/analytics/)
- Bus simulation UI: [http://localhost:5173/simulation/](http://localhost:5173/simulation/)
- LINE reservation mini app UI: [http://localhost:5173/line-reservation/](http://localhost:5173/line-reservation/)
- LINE user admin UI: [http://localhost:5173/line-admin/](http://localhost:5173/line-admin/)
- Query shortcut: [http://localhost:5173/?simulator](http://localhost:5173/?simulator)

The simulation page sends:

- GPS updates to `POST /api/vehicles/:vehicleId/location`
- Passenger events to `POST /api/vehicles/:vehicleId/passenger-events`
