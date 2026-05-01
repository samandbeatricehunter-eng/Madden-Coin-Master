import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import franchiseRouter from "./franchise.js";
import portraitsRouter from "./portraits.js";
import leagueReadRouter from "./leagueRead.js";
import economyReadRouter from "./economyRead.js";
import globalReadRouter from "./globalRead.js";
import debugReadRouter from "./debugRead.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(franchiseRouter);
router.use(portraitsRouter);
router.use(leagueReadRouter);
router.use(economyReadRouter);
router.use(globalReadRouter);
router.use(debugReadRouter);

export default router;
