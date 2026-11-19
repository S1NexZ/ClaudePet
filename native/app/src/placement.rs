//! Port of ui/src/placement.ts plus startAnchor / onSomeScreen from ui/src/main.ts. Logical pixels.
use serde::{Deserialize, Serialize};

/// height of the pet's own part of the stage: the anchor's distance from the window's top
pub const IDLE_H: f64 = 238.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Anchor {
    pub cx: f64,
    pub bottom: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// JS Math.round: halves round toward +infinity
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// Window rect for the anchor; only the pet itself is kept inside the work area.
pub fn place_stage(a: Anchor, w: f64, h: f64, wa: Area) -> Area {
    let cx = a.cx.max(wa.x + 60.0).min(wa.x + wa.width - 60.0);
    let bottom = a.bottom.min(wa.y + wa.height);
    Area { x: round(cx - w / 2.0), y: round(bottom - IDLE_H), width: w, height: h }
}

/// Parses window.json; accepts the older {x,bottom} format (window was 424 px wide then).
pub fn restore_anchor(json: &str) -> Option<Anchor> {
    let p: serde_json::Value = serde_json::from_str(json).ok()?;
    let bottom = p.get("bottom")?.as_f64()?;
    if let Some(cx) = p.get("cx").and_then(|v| v.as_f64()) {
        return Some(Anchor { cx, bottom });
    }
    p.get("x")?.as_f64().map(|x| Anchor { cx: x + 212.0, bottom })
}

/// The saved anchor if it lies inside its nearest work area, else the primary-area default.
pub fn start_anchor(saved: Option<Anchor>, nearest_work_area_of: impl Fn(f64, f64) -> Area, primary: Area) -> Anchor {
    if let Some(a) = saved {
        let wa = nearest_work_area_of(round(a.cx), round(a.bottom - 1.0));
        if a.cx >= wa.x && a.cx <= wa.x + wa.width && a.bottom > wa.y + 60.0 && a.bottom <= wa.y + wa.height + 1.0 {
            return a;
        }
    }
    Anchor {
        cx: primary.x + primary.width - 160.0,
        bottom: (primary.y + 260.0).max(primary.y + primary.height - 440.0),
    }
}

/// Is the middle of the pet's own part (window x + width/2, y + IDLE_H/2) on any work area?
pub fn on_some_screen(x: f64, y: f64, width: f64, areas: &[Area]) -> bool {
    let (px, py) = (x + width / 2.0, y + IDLE_H / 2.0);
    areas.iter().any(|d| px >= d.x && px <= d.x + d.width && py >= d.y && py <= d.y + d.height)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ar(x: f64, y: f64, width: f64, height: f64) -> Area { Area { x, y, width, height } }

    #[test]
    fn restore_anchor_formats() {
        assert_eq!(restore_anchor(r#"{"cx":500,"bottom":600}"#), Some(Anchor { cx: 500.0, bottom: 600.0 }));
        assert_eq!(restore_anchor(r#"{"x":1246,"bottom":586}"#), Some(Anchor { cx: 1458.0, bottom: 586.0 }));
        assert_eq!(restore_anchor("{nope"), None);
        assert_eq!(restore_anchor(r#"{"cx":"a","bottom":1}"#), None);
    }

    #[test]
    fn place_stage_cases() {
        let wa = ar(0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(place_stage(Anchor { cx: 800.0, bottom: 700.0 }, 424.0, 780.0, wa), ar(588.0, 462.0, 424.0, 780.0));
        assert_eq!(place_stage(Anchor { cx: 5.0, bottom: 2000.0 }, 424.0, 780.0, wa), ar(-152.0, 802.0, 424.0, 780.0));
        // JS rounding of halves: -2.5 -> -2
        assert_eq!(place_stage(Anchor { cx: 100.0, bottom: 700.0 }, 305.0, 10.0, wa).x, -52.0);
    }

    #[test]
    fn start_anchor_rules() {
        let p = ar(0.0, 0.0, 1920.0, 1040.0);
        let nearest = |_: f64, _: f64| p;
        let dflt = Anchor { cx: 1760.0, bottom: 600.0 };
        let ok = Anchor { cx: 500.0, bottom: 600.0 };
        assert_eq!(start_anchor(Some(ok), nearest, p), ok);
        assert_eq!(start_anchor(None, nearest, p), dflt);
        assert_eq!(start_anchor(Some(Anchor { cx: 5000.0, bottom: 600.0 }), nearest, p), dflt);
        assert_eq!(start_anchor(Some(Anchor { cx: 500.0, bottom: 50.0 }), nearest, p), dflt);
        assert_eq!(start_anchor(Some(Anchor { cx: 500.0, bottom: 1041.0 }), nearest, p).cx, 500.0);
        assert_eq!(start_anchor(Some(Anchor { cx: 500.0, bottom: 1042.0 }), nearest, p), dflt);
        // small screen: bottom floors at y + 260
        assert_eq!(start_anchor(None, nearest, ar(0.0, 0.0, 800.0, 600.0)), Anchor { cx: 640.0, bottom: 260.0 });
    }

    #[test]
    fn on_some_screen_cases() {
        let areas = [ar(0.0, 0.0, 1920.0, 1040.0), ar(1920.0, 0.0, 1280.0, 1024.0)];
        assert!(on_some_screen(100.0, 100.0, 424.0, &areas));
        assert!(on_some_screen(2000.0, 0.0, 424.0, &areas));
        assert!(!on_some_screen(5000.0, 100.0, 424.0, &areas));
        assert!(!on_some_screen(100.0, -200.0, 424.0, &areas)); // centre y = -81
        assert!(!on_some_screen(100.0, 100.0, 424.0, &[]));
    }
}
