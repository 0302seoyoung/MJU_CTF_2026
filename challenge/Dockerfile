FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY CatMarioWebCTF.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
COPY wwwroot ./wwwroot
COPY flag.txt /app/flag.txt

ENV ASPNETCORE_URLS=http://+:8080
ENV CTF_SECRET=jDZuDaxbgwKoJN8pAT7q6Qi8T9RcqagzFXQ0yAgdirqwtLp1

EXPOSE 8080
ENTRYPOINT ["dotnet", "CatMarioWebCTF.dll"]
