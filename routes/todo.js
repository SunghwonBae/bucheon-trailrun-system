// routes/todo.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 1. 엄마가 만든 Todo 마스터 목록 가져오기
router.get('/masters', async (req, res) => {
    try {
        const masters = await prisma.todoMaster.findMany({
            where: { isDeleted: false }
        });
        res.json(masters);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. 새로운 Todo 항목 생성 (엄마용)
router.post('/masters', async (req, res) => {
    const { title, color } = req.body;
    const newMaster = await prisma.todoMaster.create({
        data: { title, color }
    });
    res.json(newMaster);
});

// 3. 아이들이 배치한 일정 가져오기
router.get('/plans', async (req, res) => {
    const { startDate, endDate } = req.query;
    const plans = await prisma.todoPlan.findMany({
        where: { planDate: { gte: startDate, lte: endDate } },
        include: { todoMaster: true }
    });
    res.json(plans);
});

// 4. 일정 배치 (저장)
router.post('/plans', async (req, res) => {
    const { todoMasterId, childName, planDate, timeSlot } = req.body;
    const plan = await prisma.todoPlan.create({
        data: { 
            todoMasterId: Number(todoMasterId), 
            childName, 
            planDate, 
            timeSlot 
        }
    });
    res.json(plan);
});

// 5. 일정 삭제
router.delete('/plans/:id', async (req, res) => {
    await prisma.todoPlan.delete({ where: { id: Number(req.params.id) } });
    res.json({ success: true });
});

// [추가] Todo 마스터 삭제 (Soft Delete)
router.delete('/masters/:id', async (req, res) => {
    await prisma.todoMaster.update({
        where: { id: Number(req.params.id) },
        data: { isDeleted: true }
    });
    res.json({ success: true });
});

// [추가] 할 일 완료(별표시) 토글
router.patch('/plans/:id/complete', async (req, res) => {
    const { isCompleted } = req.body;
    const plan = await prisma.todoPlan.update({
        where: { id: Number(req.params.id) },
        data: { isCompleted: Boolean(isCompleted) }
    });
    res.json(plan);
});

// [추가] 일정 시간/날짜 변경 (드래그 이동 시)
router.patch('/plans/:id', async (req, res) => {
    const { planDate, timeSlot } = req.body;
    try {
        const plan = await prisma.todoPlan.update({
            where: { id: Number(req.params.id) },
            data: { planDate, timeSlot }
        });
        res.json(plan);
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
    }
});

module.exports = router;