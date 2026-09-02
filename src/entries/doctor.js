import { mountApp } from "../appShell.js";
import { renderDoctorView } from "../views/doctor.js";

mountApp({ id: "doctor", labelKey: "screen.doctor", render: renderDoctorView });
