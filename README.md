# SchoolDocs — Final School Project Prototype

**Project title:** Online School Document Request and Pickup Tracking System  
**Version:** 3.0.0  
**Platform:** Web application  
**Pickup method:** Physical pickup at the school registrar's office

SchoolDocs allows students to create an account, submit requests for school documents, and track request progress. A registrar account can review requests, update their status, and leave notes for students.

## Main features

### Student portal
- Student registration and login
- Student profile details: full name, email, 12-digit Learner Reference Number (LRN), grade level, and section
- Submit requests for certificates and school records
- Select the purpose and number of copies
- Add optional notes for the registrar
- View request history, status updates, and registrar notes
- Print a request details page
- Physical pickup reminder when a request is marked **Ready for Pickup**

### Registrar portal
- Registrar login created from private environment variables
- Dashboard with request counts
- View and search all student requests
- Filter by request status and sort by date
- Review individual requests
- Update statuses: Pending, Processing, Rejected, Ready for Pickup, and Completed
- Add a note or pickup instruction for the student
- Maintain a request status history

## Requirements

- Node.js 18 or newer
- npm (included with Node.js)
- Visual Studio Code or another code editor

## Run locally on Windows

1. Extract the ZIP file.
2. Open the extracted `SchoolDocs-Final` folder in VS Code.
3. Select **Terminal → New Terminal**.
4. Install the dependencies:

   ```bash
   npm install
   ```

5. Create the first registrar account by setting private environment variables in the same PowerShell terminal. Replace the sample values with your own:

   ```powershell
   $env:ADMIN_EMAIL="registrar@your-school.edu"
   $env:ADMIN_PASSWORD="Use-A-Unique-Password-12+"
   $env:SESSION_SECRET="Use-A-Long-Random-Secret-At-Least-32-Characters"
   npm start
   ```

   The registrar account is created on the first run when both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are provided. If you close the terminal, these temporary PowerShell variables are cleared; set them again before restarting the server. The registrar account itself remains in the local database.

6. Open this address in your browser:

   `http://localhost:3000`

7. Register a student account using a valid 12-digit LRN, then test submitting a document request. Sign out and sign in with the registrar credentials to review and update the request.

### Stop the local server

Press `Ctrl + C` in the VS Code terminal.

## Project structure

```text
SchoolDocs-Final/
├── public/
│   └── index.html       # Responsive website interface
├── data/                # Created automatically; local JSON database
├── .env.example         # Environment variable examples
├── .gitignore
├── package.json
├── package-lock.json
├── render.yaml          # Render deployment configuration
├── server.js            # Express API and application server
└── README.md
```

## Deploying a demonstration online

This project includes a `render.yaml` configuration for a demonstration deployment.

1. Create a private GitHub repository for the project.
2. Upload the project files. Do not upload `.env`, `data/`, real student records, or credentials.
3. In Render, create a Web Service and connect the repository.
4. Use `npm install` as the build command and `npm start` as the start command.
5. Add the environment variables `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the Render service settings. Use a unique strong password.
6. Render can generate `SESSION_SECRET` through the included configuration. Confirm it is set before deployment.
7. Deploy and open the URL provided by Render.

**Important hosting note:** This prototype stores records in a local JSON file and uses the default in-memory Express session store. On a free or ephemeral hosting service, records and sessions may not persist reliably across restarts or deployments. Before relying on a hosted instance, configure persistent storage and a production-grade session store. Do not use real student records on a public demo.

## Important privacy and production limitations

The Learner Reference Number (LRN) is sensitive student information. Use sample/test records only while developing or demonstrating this project. Keep the GitHub repository private during development and never publish student names, LRNs, email addresses, passwords, or database files.

This is a school-project prototype, not a production-approved student records system. Before real school use, the school/DepEd data protection and IT personnel should review and approve it. A production version should include, at minimum:

- A managed PostgreSQL database with backups and access controls
- A persistent session store and secure session configuration
- CSRF protection, rate limiting, account recovery, and school-verified student accounts
- Registrar authorization management and audit logs
- HTTPS, privacy notice, retention/deletion policy, and a security review
- School-approved document requirements, fees, processing timelines, and pickup procedures
- Proper deployment monitoring and backup/restore testing

The application does not automatically email or text students, generate official certificates, accept online payments, or deliver documents digitally. Students must log in to see status updates and collect approved documents physically from the school registrar.


## Render Blueprint deployment

This repository includes `render.yaml`. In Render, choose **New → Blueprint**, connect this GitHub repository, and apply the detected `schooldocs-portal` web service. Set the `ADMIN_EMAIL` and `ADMIN_PASSWORD` values when prompted or in the service's Environment page. Render generates `SESSION_SECRET`. The service uses `/api/health` as its health check.

The current JSON-file database and default in-memory session store are for demonstrations only. Render Free services use ephemeral storage and may spin down; do not enter real student LRNs or records. Move to PostgreSQL and a persistent session store before any real use.
