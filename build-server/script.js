const {exec} = require('child_process');
const path = require('path');
const fs = require('fs');
const {S3Client, PutObjectCommand} = require('@aws-sdk/client-s3')
const mime = require('mime-types');
const Redis = require('ioredis');

const publisher = new Redis(process.env.REDIS_URL);

function publishLog(log){
    publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({log}))
}


const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
})

const PROJECT_ID = process.env.PROJECT_ID;



async function init() {
    console.log("executing script.js");
    const outDirPath = path.join(__dirname, 'output');
    publishLog('Build Started...')
    const p = exec(`cd ${outDirPath} && rm -rf node_modules package-lock.json && npm install && npm run build`)

    p.stdout.on('data', function(data){
        console.log(data.toString());
        publishLog(data.toString());
    })

    p.stderr.on('data', function(data){
        console.error('Error', data.toString());
        publishLog(`Error: ${data.toString()}`);
    })

    p.on('close', async function (code){
        if (code !== 0) {
            console.error(`Build failed with exit code ${code}`);
            publishLog(`Build failed with exit code ${code}`);
            return;
        }
        console.log('Build Complete')
        publishLog('Build Complete')
        const distFolderPath = path.join(__dirname, 'output', 'dist')
        const distFolderContents = fs.readdirSync(distFolderPath, {recursive: true});

        publishLog('Starting to upload files.')
        for(const file of distFolderContents){
            const filePath = path.join(distFolderPath, file)
            if(fs.lstatSync(filePath).isDirectory()) continue;

            console.log('Uploading', filePath)
            publishLog(`Uploading ${file}...`)
            const command = new PutObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: `__outputs/${PROJECT_ID}/${file}`,
                Body: fs.createReadStream(filePath),
                ContentType: mime.lookup(filePath)
            })

            await s3Client.send(command);

            console.log('Upload complete', filePath);
            publishLog(`Upload complete: ${file}`)
        }
        console.log('Done...')
        publishLog('Done...')
    })
}

init();
