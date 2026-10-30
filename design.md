
Please reference to the "reference/" folder.

Create a project and run it. If the project is modified, it must restart itself.

Self-evolving agent orchestration.
Agents that evolve on their own by leading a software development team with specialized agents. About this.
Please tell me the most advanced structure.

In website development, user convenience and aesthetics are the most advanced and free and open source. top UI/UX

AutoGen Multi-agent communication, CrewAI Multi-agent teams, AutoGen Multi-agent communication

Please refer to the following to further update your current project.
Agent_Forge_CDAF_Technical_Presentation.pptx
ai_agent_engineering_workspace_presentation.pptx
https://chatgpt.com/share/6ae4248d-9674-83ea-a302-d07827bfbf26
https://chatgpt.com/share/6ae3ea1d-43e0-83e9-981c-1c959cf99c67
https://chatgpt.com/share/6ae3e8d5-6860-83ea-bb15-c5c63fd95b06
https://chatgpt.com/share/6ae43f02-1b98-83ea-8c15-325df51fd71e
https://chatgpt.com/share/6ae442ae-0510-83ea-851c-ba3c9c4d5dbc
https://chatgpt.com/share/6ae442c1-9364-83e9-a126-b1f24e177062
https://chatgpt.com/share/6ae442e1-9674-83ea-99cf-141f436d49af

For the face-to-face part, use React. Write the most advanced face-to-face section.
Please refer to the face-to-face section.
https://linear.app/?utm_source=chatgpt.com
https://vercel.com/?utm_source=chatgpt.com
https://stripe.com/en-jp?utm_source=chatgpt.com
https://www.raycast.com/?utm_source=chatgpt.com
https://supabase.com/?utm_source=chatgpt.com


An overview of the work of developing software using a group of agents, that is, using website, is described.
1. function of website
This homepage icon in Chrome should display the current service status.
Description fields must be minimized. Each area and compartment must be adjustable in width and height.
You must be able to choose between the bright and dark aspects.
You must be able to change the screen format to various types. Create about 20 screen shapes and aspects as a standard.
For screen layout and all functions, please refer to VScode + ClaudeCode.
- DashBoard
should have icons that fit their characteristics.
The dashboard icon displays the current number of notifications. Notifications are issued as notices that allow administrators, program managers, or agents to contact users. 
- Project
It displays the number of project currently running.
It displays the number of agents currently running.
should have icons that fit their characteristics.
If the project creation button is not working, there should be a delete button in the created project view.
The multi-selection function is a must.
In the Chroject Creation window, the name input box, job registration no result input, and github URL input functions must be used. The work register path must be combined with the file manager function so that the path can be entered as a file manager.
Every time the project is updated, it is uploaded to gitHub.
When a project is created, a project list should be displayed on the left side of the screen and a command window for the selected project should be displayed on the right side. 
You must be able to edit or delete the name of the project. Multiple selection possible.
The command window is a conversation window between the general manager of this project and other people. Give a command and display the results. When the project general manager receives an order, he subdivides the task and retrieves the agent from the agent management side. If not, he creates a new agent and brings it to the management side.  At this time, if the mission is subdivided into details, a very detailed task is brought about. Even if you only have one agent, if you need multiple agents, import them, duplicate them, and use them. All agents are superiors and subordinates, receive assignments from superiors, and report to superiors. In addition, it is also possible to raise opinions and implement new tasks on its own. It must be possible to input images into the command input windows.
The display in the command window must have a copy function to reduce the same content to a single silence.
Currently running agents should be displayed at the far right. Let’s also publish the cleared treatments. On the right, the number of agents is displayed.
When you press an agent, a new window opens in a spread-modal or dialog format, displaying the current agent's status, number of pros, image completion time, number of tools used (input, output, etc.), agent's mission, purpose mission, and agent information. This is displayed in the left side, and the right side displays the current usage and results that Hergent thinks about.
Important information: The project includes a project to develop this homepage as a standard. I can't delete this. Each time the modification is completed, it is automatically loaded into the github and the service machine is automatically restarted.  Restart safely.
- Agent
should have icons that fit their characteristics.
  This should be the window to manage agents(manager, developer, designer, QA, research, devops, security, ...).
  Must have roll and skill and You have a different icon accordingly.
  You should be able to use these agents here in your project. 
  When you find the agent you need for the project, if it is not there, you have to create a new one accordingly.
  The agent must establish a hierarchical relationship. They must participate in development projects by communicating with each other and working closely together. You need to improve your skills by participating in various projects. The job must have a self-learning function. The name editing function must not be available.

- FileManager
The multi-selection function is a must.
You should be able to multi-select by pressing the control.
should have icons that fit their characteristics.
The standard path is your project path.
Creating, copying/pasting, editing, viewing, deleting, moving and dragging arbitrary files and registers should all work. Also, all files and registers should have icons according to their type.
Opening a file is displayed in modal or dialog format. At this time, the strings displayed according to the file format and contents must be displayed in various colors to make them easier to read. MacDon files must be displayed in MacDon view format. There should also be an editing result storage function.
The file register structure is placed on the right, and the shell script window is at the bottom. Here, the shell script command for that path should work.
When selecting a path and entering condensation, if you press the tab in the script window, the condensation should become inertial. Press the plus button to split the file manager into one screen and display it all at once. Each file holder must click the Close button to turn it off. It must be possible to adjust the size of the divided spirit medicine.

- Model Manager
Models should have icons that fit their characteristics.
We recommend using Cloudcode as the standard. Other models must be added so that they can be used.  There should be a delete button.
The model content should include current usage, i.e. weekly usage and daily usage. The number of tokens used daily and weekly and the number of pros must be the same. The time of daily reset for another week and the time remaining until then should be the same.
- github setting
It is recommended to enter the github URL for each project.
You must upload the information to github with the information below.
git config user.name "mexcsell"
git config user.email sellmexc9@gmail.com
git push -u origin main

git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/MexcSell/AgentForge.git
git push -u origin main

git branch -M main
git push -u origin main

When uploading a project to Github, separate the files and upload only the source code.

2. Technical content
The data base is set to PostgreSQL.

Layer	Technology	Purpose
Frontend	Next.js	Website and dashboard
UI	Tailwind CSS	Fast responsive design
Backend	Fastify	High-performance API
Database	PostgreSQL	Persistent data
Cache	Redis	Fast in-memory access
Vector database	Qdrant	AI semantic memory
Authentication	Better Auth	User authentication
Deployment	Cloudflare	Hosting and edge services

https://chatgpt.com/share/6ae43f02-1b98-83ea-8c15-325df51fd71e
Analyze the functionality of your website and select the appropriate backend(node, npm, python, ...) and frontend data base(PostgreSQL, MongoDB, ...). Select the best method among node python, Java, etc. and make the choice transparently to the user.

3. database-PostgreSQL
const { Pool } = require('pg');
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'agentapp',
    user: 'agentuser',
    password: 'agentuser'
});
async function test() {
    const result = await pool.query('SELECT NOW()');
    console.log(result.rows);
}

test();