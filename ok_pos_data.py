from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
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
    
    user_id_input = wait.until(EC.presence_of_element_located((By.XPATH, "//input[@type='text']")))
    user_id_input.send_keys("사장님실제아이디") 
    
    password_input = driver.find_element(By.XPATH, "//input[@type='password']")
    password_input.send_keys("사장님실제비밀번호") 
    
    try:
        login_button = driver.find_element(By.XPATH, "//*[contains(text(), '로그인') and not(contains(text(), '자동'))]")
        login_button.click()
    except:
        password_input.submit()
    
    # 2. 메인 페이지 로딩 대기
    time.sleep(5) 
    print("로그인 완료. 매출 페이지로 이동합니다.")

    # 3. 매출 페이지(메뉴별 매출 현황) 접속
    # 방법 A: 메뉴별 매출 현황 페이지의 직접적인 URL을 아는 경우 아래에 입력 (권장)
    sales_page_url = "https://okasp.okpos.co.kr/내부/매출페이지주소.jsp"
    driver.get(sales_page_url)
    time.sleep(3)
    
    # 방법 B: URL을 모를 경우, 화면의 '매출관리' -> '메뉴별 매출' 버튼을 클릭하게 설계해야 함
    # menu_button = driver.find_element(By.XPATH, "//a[contains(text(), '메뉴별매출')]")
    # menu_button.click()
    # time.sleep(3)

    # 4. '조회' 버튼 클릭 (오늘 날짜가 기본 세팅되어 있다고 가정)
    search_button = driver.find_element(By.XPATH, "//*[contains(text(), '조회')]")
    search_button.click()
    time.sleep(3) # 데이터 로딩 대기

    # 5. 데이터 크롤링 (표 안의 데이터 추출)
    # 실제 표의 형태에 따라 xpath나 열(column) 인덱스 조정이 필요합니다.
    table_rows = driver.find_elements(By.XPATH, "//table/tbody/tr")
    
    sales_data = []
    
    for row in table_rows:
        cols = row.find_elements(By.TAG_NAME, "td")
        if len(cols) > 2: # 빈 줄이나 더미 데이터 필터링
            # 보통 첫 번째나 두 번째 열이 '메뉴명', 특정 열이 '수량'입니다.
            menu_name = cols[0].text.strip() # 메뉴명 열 위치에 맞게 인덱스 [0] 수정 필요
            quantity = cols[2].text.strip()  # 수량 열 위치에 맞게 인덱스 [2] 수정 필요
            
            if menu_name and quantity.isdigit(): # 수량이 숫자인 정상적인 행만 추출
                sales_data.append({"메뉴명": menu_name, "수량": int(quantity)})
                
    print(f"추출된 데이터: {len(sales_data)}건")
    for data in sales_data:
        print(data)

except Exception as e:
    print(f"에러 발생: {e}")

finally:
    pass