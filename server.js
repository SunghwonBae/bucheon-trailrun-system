require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const prisma = new PrismaClient();

app.use(express.static('public'));

let goalRadius = 20; // 기본값 20m

// server.js 상단에 좌표 계산 함수 추가
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // 지구 반지름 (미터)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // 거리(m) 반환
}

// 골인 지점 설정 (부천종합운동장 입구 근처 예시 - 실제 좌표로 수정 필요)
const FINISH_LINE = { lat: 37.503, lng: 126.795 }; 



// [함수] 모든 대회 데이터(입상자, 미골인자, 전체 골인자) 가져오기
async function getRaceData() {
    // 1. 부문별 입상자 (Top 5)
    const maleSenior = await prisma.trailRunner.findMany({
        where: { gender: '남', birthYear: { lte: 1978 }, finishTime: { not: null } },
        orderBy: { finishTime: 'asc' }, take: 5
    });
    const maleJunior = await prisma.trailRunner.findMany({
        where: { gender: '남', birthYear: { gte: 1979 }, finishTime: { not: null } },
        orderBy: { finishTime: 'asc' }, take: 5
    });
    const female = await prisma.trailRunner.findMany({
        where: { gender: '여', finishTime: { not: null } },
        orderBy: { finishTime: 'asc' }, take: 5
    });

    // 2. 미골인자 목록 (출발은 했으나 도착 안 함)
    const notFinished = await prisma.trailRunner.findMany({
        where: { finishTime: null, startTime: { not: null } },
        orderBy: { bibNumber: 'asc' }
    });

    // 3. 전체 골인자 목록 (최신순)
    const allFinished = await prisma.trailRunner.findMany({
        where: { finishTime: { not: null } },
        orderBy: { finishTime: 'desc' }
    });

    return { maleSenior, maleJunior, female, notFinished, allFinished };
}

io.on('connection', async (socket) => {
    console.log('접속:', socket.id);

    // 1. 접속 시 현재 대회 상태 전송 (이미 출발했는지 확인)
    const firstRunner = await prisma.trailRunner.findFirst();
    if (firstRunner && firstRunner.startTime) {
        socket.emit('race_status', { startTime: firstRunner.startTime ,isStarted: true});
    }
    
    const initialData = await getRaceData();
    socket.emit('update_ui', initialData);

    // [이벤트] 대회 출발 버튼 클릭 시
    socket.on('start_race', async () => {

        // 중복 클릭 방지를 위해 서버에서도 한 번 더 체크 가능
        const alreadyStarted = await prisma.trailRunner.findFirst({
            where: { startTime: { not: null } }
        });
        
        if (alreadyStarted) return; // 이미 시작됐다면 무시

        const now = new Date();
        // 모든 선수의 출발 시간을 현재 시간으로 설정
        await prisma.trailRunner.updateMany({
            data: { startTime: now }
        });
        io.emit('race_status', { startTime: now , isStarted: true}); // 모든 클라이언트에 타이머 시작 알림
    });
    // [이벤트] 전체 기록 리셋 (초기화)
    socket.on('reset_race', async () => {
        try {
            await prisma.trailRunner.updateMany({
                data: { 
                    startTime: null, 
                    finishTime: null,
                    autoFinishTime: null 
                }
            });
            // 모든 클라이언트에 리셋 상태 방송
            io.emit('race_reset_complete');
            console.log("전체 기록이 초기화되었습니다.");
        } catch (err) {
            console.error("리셋 실패:", err);
        }
    });

    // [이벤트] 선수 도착 처리
    socket.on('runner_arrived', async (bibNumber) => {
        try {
            const runner = await prisma.trailRunner.findUnique({
                where: { bibNumber: String(bibNumber) }
            });

            if (runner) {
                if (!runner.startTime) {
                    socket.emit('error_msg', '대회가 아직 시작되지 않았습니다!');
                    return;
                }
                
                if (!runner.finishTime) {
                    // 기록 저장
                    await prisma.trailRunner.update({
                        where: { bibNumber: String(bibNumber) },
                        data: { finishTime: new Date() } // 공식 기록 필드에 저장
                    });
                    const newData = await getRaceData();
                    io.emit('update_ui', newData);

                } else {
                    socket.emit('error_msg', '이미 골인한 선수입니다.');
                }
            } else {
                socket.emit('error_msg', '배번을 확인해주세요.');
            }
        } catch (err) {
            console.error(err);
        }
    });

    /**
     * 선수가 출발후 30분이 지나서 골인반경 20m 내에 들어오면 자동골인처리
     */
    socket.on('player_location', async (data) => {
        const { bibNumber, lat, lng } = data;
        const runner = await prisma.trailRunner.findUnique({ where: { bibNumber: String(bibNumber) } });

        if (runner && runner.startTime) {
            const distance = getDistance(lat, lng, FINISH_LINE.lat, FINISH_LINE.lng);
            const diffMinutes = (new Date() - new Date(runner.startTime)) / (1000 * 60);

            socket.emit('distance_update', { distance: Math.round(distance) });

            // 30분 경과 및 설정된 반경 이내 진입 시 (이미 기록이 있더라도 GPX 데이터는 남김)
            if (diffMinutes >= 30 && distance <= goalRadius && !runner.autoFinishTime) {
                await prisma.trailRunner.update({
                    where: { bibNumber: String(bibNumber) },
                    data: { autoFinishTime: new Date() } // 자동 기록 필드에 저장
                });
                const newData = await getRaceData();
                io.emit('update_ui', newData);
                socket.emit('auto_goal_success', { name: runner.name });
            }
        }
    });

    // [추가] 관리자 거리 설정 변경 이벤트
    socket.on('update_radius', (newRadius) => {
        goalRadius = Number(newRadius);
        io.emit('radius_changed', goalRadius); // 모든 관리자에게 알림
    });

    // [API] 모든 선수 목록 가져오기
    app.get('/api/runners', async (req, res) => {
        const runners = await prisma.trailRunner.findMany({ orderBy: { bibNumber: 'asc' } });
        res.json(runners);
    });

    // [API] 선수 정보 수정 (인라인)
    app.put('/api/runners/:id', async (req, res) => {
        const { id } = req.params;
        const { paymentStatus, ...otherData } = req.body;
        
        const runner = await prisma.trailRunner.update({
            where: { id: Number(id) },
            data: { 
                ...otherData,
                paymentStatus: paymentStatus // Y, N, F 수정 지원
            }
        });
        res.json({ message: "수정되었습니다.", runner });
    });

    // [API] 선수 삭제
    app.delete('/api/runners/:id', async (req, res) => {
        await prisma.trailRunner.delete({ where: { id: Number(req.params.id) } });
        res.json({ message: "삭제되었습니다." });
    });

    // [API] 통합 기록 초기화 (출발, 도착, 자동도착 삭제)
    app.post('/api/runners/reset-records', async (req, res) => {
        await prisma.trailRunner.updateMany({
            data: { startTime: null, finishTime: null, autoFinishTime: null }
        });
        res.json({ message: "모든 기록이 초기화되었습니다." });
    });

    // [API] 기록증 인쇄 카운트 증가
    app.post('/api/runners/:id/print', async (req, res) => {
        const { id } = req.params;
        const runner = await prisma.trailRunner.update({
            where: { id: Number(id) },
            data: { printCount: { increment: 1 } }
        });
        res.json({ message: "인쇄 카운트가 증가되었습니다.", printCount: runner.printCount });
    });

    // [API] 엑셀 데이터를 통한 선수 대량 등록 (Bulk Upsert)
    app.post('/api/runners/bulk', async (req, res) => {
        const runners = req.body; // 엑셀에서 추출된 선수 배열
        
        try {
            // 비즈니스 로직: 기존 배번이 있으면 업데이트, 없으면 생성
            const promises = runners.map(runner => {
                return prisma.trailRunner.upsert({
                    where: { bibNumber: String(runner.bibNumber) },
                    update: {
                        name: runner.name,
                        gender: runner.gender,
                        birthYear: Number(runner.birthYear),
                        affiliation: runner.affiliation,
                        phone: String(runner.phone || '')
                    },
                    create: {
                        bibNumber: String(runner.bibNumber),
                        name: runner.name,
                        gender: runner.gender,
                        birthYear: Number(runner.birthYear),
                        affiliation: runner.affiliation,
                        phone: String(runner.phone || '')
                    }
                });
            });

            await Promise.all(promises);
            res.json({ message: `${runners.length}명의 데이터가 처리되었습니다.` });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: "데이터 형식이 올바르지 않습니다." });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: ${PORT}`));