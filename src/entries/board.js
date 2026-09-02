import { mountApp } from "../appShell.js";
import { renderBoardView } from "../views/board.js";

mountApp({ id: "board", labelKey: "screen.board", render: renderBoardView });
