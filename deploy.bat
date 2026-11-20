@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ===== 괴현상관리국: 커밋 + 사이트 갱신 =====
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [오류] git이 설치되어 있지 않습니다. https://git-scm.com 에서 설치해주세요.
  goto end
)

if not exist ".git" (
  echo 처음 실행이라 git 저장소를 만듭니다.
  git init || goto fail
  git branch -M main
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo.
  echo GitHub 저장소 주소를 입력하세요. 예: https://github.com/내아이디/gwandam-wiki.git
  set /p REPO=주소: 
  if "%REPO%"=="" (
    echo 주소가 비어 있어 GitHub 올리기는 건너뜁니다.
  ) else (
    git remote add origin %REPO% || goto fail
  )
)

echo.
set "MSG="
set /p MSG=커밋 메시지 (그냥 Enter 누르면 "업데이트"): 
if "%MSG%"=="" set "MSG=업데이트"

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MSG%" || goto fail
) else (
  echo 바뀐 파일이 없어 커밋은 건너뜁니다.
)

git remote get-url origin >nul 2>nul
if not errorlevel 1 (
  echo.
  echo GitHub에 올리는 중...
  git push -u origin main || goto fail
)

echo.
echo 사이트를 갱신하는 중...
call npx wrangler deploy || goto fail

echo.
echo ===== 완료! =====
goto end

:fail
echo.
echo [오류] 중간에 실패했습니다. 위의 메시지를 확인해주세요.

:end
echo.
pause
