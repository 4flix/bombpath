# BombPath

실시간 사다리타기 폭탄 서바이벌 데스매치. 기획서는 [GDD.md](GDD.md) 참고.

## 로컬 실행

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 접속.

## 배포 (GitHub + Render.com)

1. GitHub에 저장소를 만들고 이 프로젝트를 push.
2. Render.com → New → Web Service → 방금 만든 GitHub 저장소 연결.
3. Build Command: `npm install`, Start Command: `npm start` (또는 저장소에 포함된 `render.yaml`을 Render가 자동으로 인식).
4. 배포 완료 후 발급되는 URL로 접속.

## 기술 스택
- 서버: Node.js, Express, Socket.io
- 클라이언트: Vanilla JS, HTML5 Canvas (빌드 과정 없음)
