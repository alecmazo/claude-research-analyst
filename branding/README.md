# DGA Capital Branding Assets

Save the DGA CAPITAL logo PNG files here. The app, web UI, Word reports,
and Gamma presentations all pull from these filenames:

| File                  | Used for                             | Recommended size          |
|-----------------------|--------------------------------------|---------------------------|
| `dga_logo.png`        | Word report cover (full-size)        | ~1500–3000 px wide        |
| `dga_logo_small.png`  | Web header, iPhone app, thumbnails   | ~400–800 px wide          |

Both PNGs should have a **transparent background** for clean rendering on
navy headers.

### Copy the small logo into the mobile app bundle

React Native/Expo can only bundle assets that live inside the `mobile/` tree,
so after saving `dga_logo_small.png` here, also copy it to:

```
mobile/assets/dga_logo_small.png
```

The Word report and web UI read directly from `branding/` — no copy needed.
