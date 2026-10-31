from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from webdriver_manager.chrome import ChromeDriverManager
import time

options = webdriver.ChromeOptions()
options.add_argument('--start-maximized') 

driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)

try:
    # 1. 로그인
    login_url = "https://okasp.okpos.co.kr/login/login_form.jsp" 
    driver.get(login_url)
    wait = WebDriverWait(driver, 10)
    
        wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='text']"))).send_keys(
            __import__("os").environ.get("OKPOS_ID", "")
        )
    driver.find_element(By.XPATH, "//input[@type='password']").send_keys(
        __import__("os").environ.get("OKPOS_PASSWORD", "")
    ) 
    
    try:
        driver.find_element(By.XPATH, "//*[contains(text(), '로그인') and not(contains(text(), '자동'))]").click()
    except:
        driver.find_element(By.XPATH, "//input[@type='password']").submit()
    
    time.sleep(3)
    
    # 2. Alert 경고창 처리
    try:
        WebDriverWait(driver, 3).until(EC.alert_is_present())
        driver.switch_to.alert.accept()
    except:
        pass 

    # 3. 레이어 팝업 닫기 및 투명막 제거
    print("팝업창 처리 중...")
    try:
        for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '하루동안 창 열리지 않음')]"):
            if btn.is_displayed(): btn.click(); time.sleep(0.5)
        for btn in driver.find_elements(By.XPATH, "//*[contains(text(), '닫기')]"):
            if btn.is_displayed(): btn.click(); time.sleep(0.5)
        driver.execute_script("document.querySelectorAll('[id^=\"divPopupBackground\"]').forEach(el => el.style.display='none');")
    except:
        pass
    time.sleep(2)

    # 4. 메뉴 이동
    print("메뉴 이동 중...")
    driver.execute_script("arguments[0].click();", wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '매출관리')]"))))
    time.sleep(1)
    
    ActionChains(driver).move_to_element(wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '매출현황')]")))).perform()
    time.sleep(1)
    
    driver.execute_script("arguments[0].click();", wait.until(EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '상품별')]"))))
    time.sleep(3)

    # 5. 이중 프레임 완벽 탐색 및 '조회' 버튼 클릭
    print("데이터가 있는 진짜 창(이중 프레임)을 찾습니다...")
    def click_search_in_frames():
        driver.switch_to.default_content()
        frames1 = driver.find_elements(By.XPATH, "//iframe | //frame")
        for f1 in frames1:
            driver.switch_to.default_content()
            try:
                driver.switch_to.frame(f1)
                btns = driver.find_elements(By.XPATH, "//button[contains(text(), '조회')]")
                if btns:
                    driver.execute_script("arguments[0].click();", btns[0])
                    print("✅ 1단계 프레임에서 조회 버튼 클릭 완료!")
                    return True
                
                frames2 = driver.find_elements(By.XPATH, "//iframe | //frame")
                for f2 in frames2:
                    driver.switch_to.default_content()
                    driver.switch_to.frame(f1)
                    driver.switch_to.frame(f2)
                    btns2 = driver.find_elements(By.XPATH, "//button[contains(text(), '조회')]")
                    if btns2:
                        driver.execute_script("arguments[0].click();", btns2[0])
                        print("✅ 2단계(중첩) 프레임에서 조회 버튼 클릭 완료!")
                        return True
            except:
                continue
        return False

    is_clicked = click_search_in_frames()
    time.sleep(5)

    # 6. 표 데이터 엑스레이 크롤링 (모든 칸 강제 출력)
    print("데이터 엑스레이 추출을 시작합니다.")
    
    # tbody 안의 tr만 찾아서 불필요한 헤더 노이즈를 줄임
    rows = driver.find_elements(By.XPATH, "//tbody/tr")
    
    valid_count = 0
    for row in rows:
        cols = row.find_elements(By.TAG_NAME, "td")
        
        # 칸이 5개 이상인 의미 있는 행만 탐색
        if len(cols) > 5:
            # 빈칸이든 숨겨진 칸이든 상관없이 리스트에 모두 담습니다.
            row_data = [col.text.strip() for col in cols]
            row_str = "".join(row_data)
            
            # 소계, 합계가 아닌 진짜 데이터 행이라고 판단되면 출력
            if row_str and "소계" not in row_str and "합계" not in row_str and "상품명" not in row_str:
                print(f"\n[데이터 발견! 총 {len(row_data)}칸]")
                # 인덱스 번호와 함께 출력하여 보기 쉽게 만듦
                for idx, val in enumerate(row_data):
                    print(f"  - 인덱스[{idx}] : '{val}'")
                
                valid_count += 1
                
        # 너무 많이 출력될 필요 없이 상위 3개 행만 찾으면 멈춥니다.
        if valid_count >= 3:
            break

    if valid_count > 0:
        print("\n[확인 요청] 위 출력 결과에서 '상품명'(예: 껍데기, 이벤트_쿠폰 등)과 '수량'(숫자)이 각각 [몇 번 인덱스]에 들어있는지 확인해 주세요!")
    else:
        print("\n❌ 데이터를 찾지 못했습니다.")

except Exception as e:
    print(f"에러 발생: {e}")
finally:
    pass