// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const prisma = new PrismaClient();

// 정적 파일 제공 (public 폴더 안의 파일들을 읽을 수 있게 함)
app.use(express.static('public'));

// [API] 1. 전체 선수 목록 가져오기
app.get('/api/runners', async (req, res) => {
    try {
        const runners = await prisma.trailRunner.findMany({
            orderBy: { bibNumber: 'asc' }
        });
        res.json(runners);
    } catch (error) {
        res.status(500).json({ error: 'DB 로드 실패' });
    }
});

// [Socket] 2. 실시간 통신 설정
io.on('connection', (socket) => {
    console.log('운영자 접속:', socket.id);

    // 자원봉사자가 배번을 전송했을 때
    socket.on('runner_arrived', async (bibNumber) => {
        try {
            // 해당 배번의 선수를 찾음
            const runner = await prisma.trailRunner.findUnique({
                where: { bibNumber: String(bibNumber) }
            });

            if (runner && !runner.finishTime) {
                // 도착 시간 기록 (현재 시간)
                const updatedRunner = await prisma.trailRunner.update({
                    where: { bibNumber: String(bibNumber) },
                    data: { finishTime: new Date() }
                });

                // 💡 중요: 모든 접속자에게 업데이트된 정보 방송
                io.emit('update_board', updatedRunner);
                console.log(`배번 ${bibNumber}번 골인!`);
            } else if (runner && runner.finishTime) {
                socket.emit('error_msg', '이미 기록이 있는 선수입니다.');
            } else {
                socket.emit('error_msg', '존재하지 않는 배번입니다.');
            }
        } catch (err) {
            console.error(err);
            socket.emit('error_msg', '서버 오류가 발생했습니다.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`트레일러닝 서버 시작: http://localhost:${PORT}`);
});