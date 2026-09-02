import { mountApp } from "../appShell.js";
import { renderFrontDeskView } from "../views/frontdesk.js";

mountApp({ id: "frontdesk", labelKey: "screen.frontdesk", render: renderFrontDeskView });
