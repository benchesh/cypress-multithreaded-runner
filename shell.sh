#!/bin/bash

cypressConfigFilepath="$2"
thread="$3"
threadNo="$4"
allureResultsPath="$1/$threadNo"

if [[ "$5" == "" ]]; then
    browser=""
else
    browser="--browser $5"
fi

additionalCypressEnvArgs="$6"

cypress run $browser --config-file "$cypressConfigFilepath" --e2e --config="$thread" --env allure=true,allureResults="$allureResultsPath""$additionalCypressEnvArgs"

echo Thread \#"$threadNo" has completed.
