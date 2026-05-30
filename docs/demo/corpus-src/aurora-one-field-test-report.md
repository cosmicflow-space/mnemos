% Aurora One — Field Test Report
% QA Team, Aurora Labs
% 2026-04-02

# Summary

The Aurora One prototype (revision C) was field-tested across three environments
to validate the published heat-up and brew-time targets. **The unit passed the
cold-weather requirement** and met brew-time targets in full sun. Low-light
heat-up was slower than spec but within the acceptable range.

# Test conditions

| Site | Ambient temp | Light condition | Altitude |
|---|---|---|---|
| Coastal beach | 24 °C | Full sun | sea level |
| Mountain ridge | −3 °C | Full sun | 2,400 m |
| City park | 12 °C | Overcast | 60 m |

# Results

## Heat-up time (water to 92 °C)

| Site | Target | Measured | Verdict |
|---|---|---|---|
| Coastal beach | 4 min | 3 min 50 s | PASS |
| Mountain ridge | 4 min | 4 min 35 s | PASS (within tolerance) |
| City park | 9 min | 9 min 10 s | PASS |

The **cold-weather requirement** was that the unit must reach brew temperature
within 5 minutes at or below freezing in full sun. On the mountain ridge at
−3 °C the unit hit 92 °C in 4 minutes 35 seconds — comfortably inside the
5-minute limit. **Requirement satisfied.**

## Brew time and pressure

In full sun the piston held a steady 9 bar and pulled a 40 ml double shot in
27–29 seconds at all sites, matching the 28-second spec. Pressure never
dropped below 8.6 bar during any pull.

# Recommendations

1. Ship revision C as-is for the spring launch.
2. Add a panel-alignment indicator — misaligned panels were the top cause of
   slow heat-up in informal testing.
3. Document the overcast heat-up figure (~9 minutes) prominently so buyers set
   correct expectations.

# Sign-off

Field test passed. Cleared for production.
