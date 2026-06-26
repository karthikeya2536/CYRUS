import time
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = context.new_page()

        print("Navigating to login...")
        page.goto('http://localhost:5173/login')
        page.wait_for_load_state('networkidle')

        print("Filling login details...")
        page.fill('input[type="email"]', 'test_1781598540037@example.com')
        page.fill('input[type="password"]', 'password123')
        page.click('button[type="submit"]')

        print("Waiting for dashboard...")
        page.wait_for_url('**/dashboard', timeout=15000)
        page.wait_for_load_state('networkidle')

        print("Navigating to briefings...")
        page.click('text="Briefings"')
        page.wait_for_url('**/briefings', timeout=10000)
        page.wait_for_load_state('networkidle')

        print("Counting briefings before...")
        
        # Click Generate Briefing
        print("Clicking Generate Briefing...")
        page.click('text="Generate Briefing"')
        
        print("Waiting for generation to finish...")
        # The button turns into 'Generating...' and then back to 'Generate Briefing'
        # Or we can wait for a new 'Latest briefing' element if it wasn't there
        # Let's just wait until the 'Generating...' state disappears
        page.wait_for_selector('text="Generating..."', state='hidden', timeout=60000)
        
        # wait a bit for the UI to settle and re-fetch briefings
        page.wait_for_timeout(3000)
        page.wait_for_load_state('networkidle')

        print("Taking screenshot...")
        screenshot_path = r'C:\Users\yemul\.gemini\antigravity\brain\b5e59e71-1d04-4fb5-88f5-83ae5197bd21\briefings_page.png'
        page.screenshot(path=screenshot_path, full_page=True)
        print(f"Screenshot saved to {screenshot_path}")

        browser.close()

if __name__ == '__main__':
    run()
