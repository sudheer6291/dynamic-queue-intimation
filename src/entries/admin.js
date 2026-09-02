import { mountApp } from "../appShell.js";
import { renderAdminView } from "../views/admin.js";

mountApp({ id: "admin", labelKey: "screen.admin", render: renderAdminView });
