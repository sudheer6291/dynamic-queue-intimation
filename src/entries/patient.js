import { mountApp } from "../appShell.js";
import { renderPatientView } from "../views/patient.js";

mountApp({ id: "patient", labelKey: "screen.patient", render: renderPatientView });
