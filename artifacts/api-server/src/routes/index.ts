import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import franchiseRouter from "./franchise.js";
import portraitsRouter from "./portraits.js";
import leagueReadRouter from "./leagueRead.js";
import economyReadRouter from "./economyRead.js";
import globalReadRouter from "./globalRead.js";
import debugReadRouter from "./debugRead.js";
import v2ReadRouter from "./v2Read.js";
import v2FranchiseRouter from "./v2Franchise.js";
import v2AuthRouter from "./v2Auth.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(franchiseRouter);
router.use(v2FranchiseRouter);
router.use(portraitsRouter);
router.use(leagueReadRouter);
router.use(economyReadRouter);
router.use(globalReadRouter);
router.use(debugReadRouter);
router.use(v2ReadRouter);
router.use(v2AuthRouter);

export default router;
