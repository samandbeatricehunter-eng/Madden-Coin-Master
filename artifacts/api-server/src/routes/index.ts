import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import franchiseRouter from "./franchise.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(franchiseRouter);

export default router;
