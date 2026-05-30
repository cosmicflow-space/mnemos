from playwright.sync_api import sync_playwright
import pathlib
base = pathlib.Path("/tmp/gif-scene")
url = (base/"scene.html").as_uri()
with sync_playwright() as p:
    b=p.chromium.launch(headless=True, args=["--allow-file-access-from-files"])
    pg=b.new_page(viewport={"width":1200,"height":630}, device_scale_factor=2)
    pg.goto(url, wait_until="networkidle"); pg.wait_for_timeout(600)
    # confirm laptop image actually loaded
    nw = pg.eval_on_selector(".shot img","img=>img.naturalWidth")
    print("laptop img naturalWidth:", nw)
    for step in [0,1,2,3]:
        pg.evaluate(f"window.setStep({step})")
        pg.wait_for_timeout(450)
        pg.screenshot(path=str(base/f"frames/{step:02d}.png"))
    print("frames captured")
    b.close()
